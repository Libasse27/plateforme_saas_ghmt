import { Injectable } from '@nestjs/common';
import type { MfaVerifyInput, SessionTokens } from '@ghmt/shared';
import { AuditService } from '../../../common/audit/audit.service';
import { parseOpaqueToken } from '../../../common/auth/opaque-token';
import { AuthorizationService } from '../../../common/authz/authorization.service';
import { DomainError } from '../../../common/errors/domain-error';
import { Clock } from '../../../common/time/clock';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { loadTenantProfile } from '../../../infrastructure/tenancy/tenant-profile';
import { MFA_CHALLENGE_MAX_ATTEMPTS, TOTP_KIND } from '../auth.constants';
import { registerFailedAttempt } from './failed-attempts';
import { LoginCompletionService } from './login-completion.service';
import { LoginDelayEventsService } from './login-delay-events.service';
import { LoginDelayService } from './login-delay.service';
import { MfaCodeChecker, type FactorSnapshot } from './mfa-code-checker.service';
import { SessionService } from './session.service';

/** Issue de la transaction de vérification ; `released` : challenge pris ou devenu invalide entre-temps (pas un échec). */
type AttemptResult = { kind: 'ok'; tokens: SessionTokens } | { kind: 'released' } | { kind: 'wrong_code'; userId: string; fullName: string };

interface PendingChallenge {
  readonly challengeId: string;
  readonly attempts: number;
  readonly userId: string;
  readonly email: string;
  readonly fullName: string;
  readonly factor: FactorSnapshot;
}

/** Challenge lu avant l'admission, avec l'identifiant du délai progressif (`slug|email`). */
interface Preflight {
  readonly tenantSlug: string;
  readonly email: string;
}

function invalidMfa(): DomainError {
  return new DomainError('invalid_mfa_code', 401, 'Unauthorized', 'Code de vérification invalide ou expiré.');
}

/**
 * Second facteur de la connexion. Un code faux compte dans le délai progressif de l'identifiant (docs/11 §14.2 H2), et le
 * délai est contrôlé en tête : pendant le délai, même le bon code reçoit `429 login_delayed`.
 * Le stockage de limitation (Redis) n'est jamais appelé dans une transaction : lecture du challenge, admission hors
 * transaction, vérification en transaction, puis effets Redis (remise à zéro, rendu, alerte) après le commit.
 */
@Injectable()
export class MfaVerifyService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly codes: MfaCodeChecker,
    private readonly audit: AuditService,
    private readonly authz: AuthorizationService,
    private readonly sessions: SessionService,
    private readonly completion: LoginCompletionService,
    private readonly delay: LoginDelayService,
    private readonly delayEvents: LoginDelayEventsService,
    private readonly clock: Clock,
  ) {}

  async verify(input: MfaVerifyInput): Promise<SessionTokens> {
    const parsed = parseOpaqueToken(input.challengeId);
    if (!parsed) throw invalidMfa();
    const { tenantId, hash } = parsed;
    const now = this.clock.now();

    const preflight = await this.tenantDb.runAs(tenantId, (tx) => this.loadPreflight(tx, tenantId, hash, now));
    if (!preflight) throw invalidMfa();
    const { tenantSlug, email } = preflight;
    // Contrôle et réservation atomiques AVANT toute vérification du code, hors transaction.
    const admission = await this.delay.admit(tenantSlug, email, now, () => this.fromTrustedNetwork(tenantId));
    if (!admission.allowed) {
      await this.delayEvents.delayed(tenantSlug, email, admission.retryAfterSeconds, 'mfa');
      throw DomainError.loginDelayed(admission.retryAfterSeconds);
    }

    // Les essais, l'échec et l'audit sont validés (commit) avant de lever l'erreur.
    const outcome = await this.tenantDb.runAs(tenantId, (tx) => this.attempt(tx, tenantId, hash, input.code, now));
    if (outcome.kind === 'ok') {
      await this.delay.clear(tenantSlug, email);
      return outcome.tokens;
    }
    if (outcome.kind === 'released') {
      await this.delay.release(tenantSlug, email);
      throw invalidMfa();
    }
    await this.delayEvents.failureCounted({ tenantId, tenantSlug, userId: outcome.userId, email, fullName: outcome.fullName, count: admission.count });
    throw invalidMfa();
  }

  private async loadPreflight(tx: TenantTx, tenantId: string, tokenHash: Uint8Array<ArrayBuffer>, now: Date): Promise<Preflight | undefined> {
    const pending = await this.loadPending(tx, tenantId, tokenHash, now);
    if (!pending) return undefined;
    return { tenantSlug: (await loadTenantProfile(tx)).slug, email: pending.email };
  }

  /** IP de la requête dans une plage de confiance de l'établissement (lecture dans sa propre transaction, courte). */
  private fromTrustedNetwork(tenantId: string): Promise<boolean> {
    return this.tenantDb.runAs(tenantId, async (tx) => (await this.authz.loadNetworkPolicy(tx, this.sessions.clientMeta().ip)).networkTrusted);
  }

  private async attempt(tx: TenantTx, tenantId: string, tokenHash: Uint8Array<ArrayBuffer>, code: string, now: Date): Promise<AttemptResult> {
    // Relu sous transaction : le challenge a pu être consommé ou expirer depuis la lecture préalable.
    const pending = await this.loadPending(tx, tenantId, tokenHash, now);
    if (!pending) return { kind: 'released' };

    // Essai réservé AVANT la vérification : des requêtes parallèles ne dépassent jamais 5 essais.
    const reserved = await tx.mfaChallenge.updateMany({
      where: { tenantId, id: pending.challengeId, consumedAt: null, attempts: { lt: MFA_CHALLENGE_MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (reserved.count === 0) return { kind: 'released' };

    const method = await this.codes.check(tx, tenantId, pending.factor, code);
    if (!method) {
      await this.recordWrongCode(tx, tenantId, pending);
      return { kind: 'wrong_code', userId: pending.userId, fullName: pending.fullName };
    }

    const consumed = await tx.mfaChallenge.updateMany({ where: { tenantId, id: pending.challengeId, consumedAt: null }, data: { consumedAt: now } });
    if (consumed.count === 0) return { kind: 'released' };
    const tokens = await this.completion.complete(tx, { tenantId, userId: pending.userId, method, mfaVerified: true, mfaEnrolled: true });
    return { kind: 'ok', tokens };
  }

  /** Challenge utilisable (non consommé, non expiré) d'un utilisateur actif avec un TOTP actif. */
  private async loadPending(tx: TenantTx, tenantId: string, tokenHash: Uint8Array<ArrayBuffer>, now: Date): Promise<PendingChallenge | undefined> {
    const challenge = await tx.mfaChallenge.findUnique({ where: { tenantId_tokenHash: { tenantId, tokenHash } } });
    if (!challenge || challenge.consumedAt || challenge.expiresAt <= now) return undefined;
    const user = await tx.user.findUnique({
      where: { tenantId_id: { tenantId, id: challenge.userId } },
      select: {
        email: true,
        fullName: true,
        status: true,
        deletedAt: true,
        mfaFactors: { where: { kind: TOTP_KIND, activatedAt: { not: null } }, select: { id: true, secretEnc: true, lastUsedStep: true, userId: true } },
      },
    });
    const factor = user?.mfaFactors[0];
    if (!user || !factor || user.status !== 'active' || user.deletedAt) return undefined;
    return { challengeId: challenge.id, attempts: challenge.attempts, userId: challenge.userId, email: user.email, fullName: user.fullName, factor };
  }

  private async recordWrongCode(tx: TenantTx, tenantId: string, pending: PendingChallenge): Promise<void> {
    await registerFailedAttempt(tx, tenantId, pending.userId);
    await this.audit.record(tx, tenantId, {
      action: 'auth.mfa.failed',
      outcome: 'failure',
      actorUserId: pending.userId,
      changes: { attempt: pending.attempts + 1 },
    });
  }
}
