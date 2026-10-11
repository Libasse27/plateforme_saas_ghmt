import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { LOGIN_DELAY_SECONDS, loginDelaySeconds } from '@ghmt/shared';
import { RATE_LIMIT_STORE } from '../../../common/rate-limit/rate-limit-runtime';
import type { FailureRecord, RateLimitStore } from '../../../common/rate-limit/rate-limit-store';
import { DELAYED_AUDIT_WINDOW_MS, LOGIN_FAILURE_TTL_MS, TRUSTED_NETWORK_DELAY_CAP_SECONDS } from '../auth.constants';

const SECOND_MS = 1_000;

/** Clé du compteur : `sha256(tenantSlug|email)` normalisés, même si le compte n'existe pas (aucun oracle, docs/11 D3). */
export function loginIdentifierKey(tenantSlug: string, email: string): string {
  const digest = createHash('sha256').update(`${tenantSlug.trim().toLowerCase()}|${email.trim().toLowerCase()}`).digest('hex');
  return `login-delay:${digest}`;
}

const alertKey = (tenantId: string, userId: string): string => `login:alerted:${tenantId}:${userId}`;
const DELAYED_AUDIT_SCHEDULE: readonly number[] = [DELAYED_AUDIT_WINDOW_MS / SECOND_MS];
const delayedAuditKey = (tenantSlug: string, email: string): string => `${loginIdentifierKey(tenantSlug, email)}:audited`;

/** Admission d'une tentative : refusée pendant le délai, sinon déjà comptée comme un échec (`count` l'inclut). */
export interface LoginAdmission {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
  readonly count: number;
}

/** Évaluation paresseuse du réseau de confiance (requête en base) : appelée seulement si le plafond changerait le délai. */
export type TrustedNetworkProbe = () => Promise<boolean>;

/**
 * Délai progressif de connexion (docs/11 D3) : après le n-ième échec consécutif, la tentative suivante n'est examinée
 * qu'après `LOGIN_DELAY_SECONDS[n-1]` secondes, compté depuis le dernier échec. Le compteur vit dans le stockage de
 * limitation (Redis, partagé entre instances) et expire 24 h après le dernier échec.
 */
@Injectable()
export class LoginDelayService {
  constructor(@Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore) {}

  /** Secondes à attendre avant d'examiner une tentative pour cet identifiant (0 : examen immédiat). */
  async retryAfterSeconds(tenantSlug: string, email: string, now: Date): Promise<number> {
    const record = await this.store.get(loginIdentifierKey(tenantSlug, email));
    return record ? this.remainingSeconds(record, now.getTime()) : 0;
  }

  /**
   * ATOMIQUE (script Lua sur Redis, opération synchrone en mémoire) : décide si la tentative est examinée et, si oui, la compte
   * aussitôt comme un échec. Une réussite efface le compteur (`clear`) ; un mot de passe juste devant un second facteur rend la
   * réservation (`release`). Depuis un réseau de confiance, le délai est plafonné à 60 s (décision 21).
   */
  async admit(tenantSlug: string, email: string, now: Date, trustedNetwork?: TrustedNetworkProbe): Promise<LoginAdmission> {
    const key = loginIdentifierKey(tenantSlug, email);
    const cap = await this.capFor(key, now, trustedNetwork);
    const gate = await this.store.gate(key, LOGIN_FAILURE_TTL_MS, now.getTime(), LOGIN_DELAY_SECONDS, cap);
    return { allowed: gate.allowed, retryAfterSeconds: gate.allowed ? 0 : Math.ceil(gate.retryAfterMs / SECOND_MS), count: gate.count };
  }

  /** Rend une tentative réservée par `admit` (ce n'était pas un échec). */
  release(tenantSlug: string, email: string): Promise<void> {
    return this.store.release(loginIdentifierKey(tenantSlug, email));
  }

  /**
   * Vrai pour le premier refus `login_delayed` d'un identifiant dans l'heure : borne l'audit `auth.login.delayed`.
   * Porte atomique à palier unique (une heure après chaque audit accordé), datée par `now` comme le reste du délai.
   */
  async claimDelayedAudit(tenantSlug: string, email: string, now: Date): Promise<boolean> {
    const gate = await this.store.gate(delayedAuditKey(tenantSlug, email), DELAYED_AUDIT_WINDOW_MS, now.getTime(), DELAYED_AUDIT_SCHEDULE, null);
    return gate.allowed;
  }

  recordFailure(tenantSlug: string, email: string, now: Date): Promise<FailureRecord> {
    return this.recordAt(loginIdentifierKey(tenantSlug, email), now);
  }

  clear(tenantSlug: string, email: string): Promise<void> {
    return this.store.reset(loginIdentifierKey(tenantSlug, email));
  }

  /** Vrai pour la première alerte « tentatives inhabituelles » d'un compte dans les 24 h (clé `login:alerted:{tenant}:{user}`). */
  async claimSuspiciousAlert(tenantId: string, userId: string): Promise<boolean> {
    const hit = await this.store.hit(alertKey(tenantId, userId), LOGIN_FAILURE_TTL_MS, 1, 0);
    return !hit.isBlocked;
  }

  private async recordAt(key: string, now: Date): Promise<FailureRecord> {
    const current = await this.store.get(key);
    // Compteur périmé (plus de 24 h sans échec) : on repart de zéro même si le stockage ne l'a pas encore purgé.
    if (current && now.getTime() - current.lastAtMs > LOGIN_FAILURE_TTL_MS) await this.store.reset(key);
    return this.store.recordFailure(key, LOGIN_FAILURE_TTL_MS, now.getTime());
  }

  /** Plafond applicable : seulement si le délai du palier courant le dépasse et que l'IP est sur un réseau de confiance. */
  private async capFor(key: string, now: Date, trustedNetwork: TrustedNetworkProbe | undefined): Promise<number | null> {
    if (!trustedNetwork) return null;
    const record = await this.store.get(key);
    if (!record || now.getTime() - record.lastAtMs > LOGIN_FAILURE_TTL_MS) return null;
    if (loginDelaySeconds(record.count) <= TRUSTED_NETWORK_DELAY_CAP_SECONDS) return null;
    return (await trustedNetwork()) ? TRUSTED_NETWORK_DELAY_CAP_SECONDS : null;
  }

  private remainingSeconds(record: FailureRecord, nowMs: number): number {
    if (nowMs - record.lastAtMs > LOGIN_FAILURE_TTL_MS) return 0;
    const releaseAt = record.lastAtMs + loginDelaySeconds(record.count) * SECOND_MS;
    return releaseAt > nowMs ? Math.ceil((releaseAt - nowMs) / SECOND_MS) : 0;
  }
}
