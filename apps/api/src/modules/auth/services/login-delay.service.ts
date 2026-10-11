import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { LOGIN_DELAY_SECONDS, loginDelaySeconds } from '@ghmt/shared';
import { RATE_LIMIT_STORE } from '../../../common/rate-limit/rate-limit-runtime';
import type { FailureRecord, RateLimitStore } from '../../../common/rate-limit/rate-limit-store';
import { ipRateLimitKey } from '../../../common/throttle/ip-bucket';
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

/** Compteur secondaire compte + IP (décision 25) : IPv6 regroupée par /64, IP hachée (aucune adresse en clair dans Redis). */
function accountIpKey(accountKey: string, ip: string): string {
  return `${accountKey}:ip:${createHash('sha256').update(ipRateLimitKey(ip)).digest('hex')}`;
}

/** Admission d'une tentative : refusée pendant le délai, sinon déjà comptée comme un échec (`count` l'inclut). */
export interface LoginAdmission {
  readonly allowed: boolean;
  readonly retryAfterSeconds: number;
  readonly count: number;
  /** Compteur réservé : celui du compte ou, depuis un contexte connu, le compteur compte + IP (décision 25). */
  readonly key: string;
}

/** Contexte de la requête pour ce compte : IP cliente, réseau de confiance de l'établissement, IP d'une session antérieure. */
export interface LoginContext {
  readonly ip: string | null;
  readonly trustedNetwork: boolean;
  readonly knownIp: boolean;
}

/** Évaluation paresseuse du contexte (requêtes en base) : appelée seulement si le compteur du compte impose un délai. */
export type LoginContextProbe = () => Promise<LoginContext>;

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
   * réservation (`release`).
   *
   * Blocage ciblé (décision 25) : quand le compteur du compte impose un délai, une tentative venue d'un réseau de confiance
   * ou d'une IP déjà utilisée avec succès par ce compte est examinée sur son propre compteur compte + IP ; les échecs venus
   * d'ailleurs ne la retardent pas. Depuis un réseau de confiance, ce délai reste plafonné à 60 s (décision 21).
   */
  async admit(tenantSlug: string, email: string, now: Date, context?: LoginContextProbe): Promise<LoginAdmission> {
    const accountKey = loginIdentifierKey(tenantSlug, email);
    const { key, cap } = await this.counterFor(accountKey, now, context);
    const gate = await this.store.gate(key, LOGIN_FAILURE_TTL_MS, now.getTime(), LOGIN_DELAY_SECONDS, cap);
    return { allowed: gate.allowed, retryAfterSeconds: gate.allowed ? 0 : Math.ceil(gate.retryAfterMs / SECOND_MS), count: gate.count, key };
  }

  /** Rend une tentative réservée par `admit` (ce n'était pas un échec), sur le compteur qui l'a réservée. */
  release(admission: LoginAdmission): Promise<void> {
    return this.store.release(admission.key);
  }

  /**
   * Vrai pour le premier refus `login_delayed` d'un identifiant dans l'heure : borne l'audit `auth.login.delayed`.
   * Porte atomique à palier unique (une heure après chaque audit accordé), datée par `now` comme le reste du délai.
   */
  async claimDelayedAudit(tenantSlug: string, email: string, now: Date): Promise<boolean> {
    const gate = await this.store.gate(delayedAuditKey(tenantSlug, email), DELAYED_AUDIT_WINDOW_MS, now.getTime(), DELAYED_AUDIT_SCHEDULE, null);
    return gate.allowed;
  }

  /**
   * Remise à zéro après une réussite : le compteur qui a admis la tentative. Une réussite depuis un contexte connu n'efface
   * donc pas les échecs venus d'ailleurs (sinon chaque connexion légitime rendrait des essais à l'attaquant). Sans admission
   * (déverrouillage par un administrateur) : le compteur du compte.
   */
  clear(tenantSlug: string, email: string, admission?: LoginAdmission): Promise<void> {
    return this.store.reset(admission?.key ?? loginIdentifierKey(tenantSlug, email));
  }

  /** Vrai pour la première alerte « tentatives inhabituelles » d'un compte dans les 24 h (clé `login:alerted:{tenant}:{user}`). */
  async claimSuspiciousAlert(tenantId: string, userId: string): Promise<boolean> {
    const hit = await this.store.hit(alertKey(tenantId, userId), LOGIN_FAILURE_TTL_MS, 1, 0);
    return !hit.isBlocked;
  }

  /** Compteur examiné : celui du compte, sauf s'il impose un délai et que la requête vient d'un contexte connu (décision 25). */
  private async counterFor(accountKey: string, now: Date, context: LoginContextProbe | undefined): Promise<{ key: string; cap: number | null }> {
    const account = { key: accountKey, cap: null };
    if (!context) return account;
    const record = await this.store.get(accountKey);
    if (!record || now.getTime() - record.lastAtMs > LOGIN_FAILURE_TTL_MS || loginDelaySeconds(record.count) === 0) return account;
    const { ip, trustedNetwork, knownIp } = await context();
    if (!ip || !(trustedNetwork || knownIp)) return account;
    return { key: accountIpKey(accountKey, ip), cap: trustedNetwork ? TRUSTED_NETWORK_DELAY_CAP_SECONDS : null };
  }

  private remainingSeconds(record: FailureRecord, nowMs: number): number {
    if (nowMs - record.lastAtMs > LOGIN_FAILURE_TTL_MS) return 0;
    const releaseAt = record.lastAtMs + loginDelaySeconds(record.count) * SECOND_MS;
    return releaseAt > nowMs ? Math.ceil((releaseAt - nowMs) / SECOND_MS) : 0;
  }
}
