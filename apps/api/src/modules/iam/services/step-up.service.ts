import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { AuditService } from '../../../common/audit/audit.service';
import type { Principal } from '../../../common/context/request-context';
import { DomainError } from '../../../common/errors/domain-error';
import { RATE_LIMIT_STORE } from '../../../common/rate-limit/rate-limit-runtime';
import type { RateLimitStore } from '../../../common/rate-limit/rate-limit-store';
import { Clock } from '../../../common/time/clock';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { TOTP_KIND } from '../../auth/auth.constants';
import { MfaCodeChecker } from '../../auth/services/mfa-code-checker.service';

// Copie de la règle de `mfa-code-checker.service.ts` (non exportée) : un code de secours n'est jamais accepté ici.
const TOTP_CODE = /^\d{6}$/;
const SECOND_MS = 1_000;
/** Échecs tolérés par utilisateur sur la fenêtre glissante, puis blocage jusqu'à 15 min après le dernier échec. */
export const STEP_UP_MAX_FAILURES = 5;
const STEP_UP_WINDOW_MS = 15 * 60_000;
const STEP_UP_SCHEDULE: readonly number[] = [...Array<number>(STEP_UP_MAX_FAILURES - 1).fill(0), STEP_UP_WINDOW_MS / SECOND_MS];

const stepUpKey = (tenantId: string, userId: string): string => `stepup:${tenantId}:${userId}`;

type Outcome = { kind: 'ok' } | { kind: 'required' } | { kind: 'invalid' } | { kind: 'blocked'; retryAfterSeconds: number };

/** Contrôles métier exécutés avant le code (ex. principal seul) : leur refus ne consomme ni code ni essai. */
export type StepUpPrecheck = (tx: TenantTx) => Promise<void>;

export function stepUpRequired(): DomainError {
  return new DomainError('mfa_step_up_required', HttpStatus.UNAUTHORIZED, 'Unauthorized', 'Saisissez le code à 6 chiffres de votre application d’authentification.');
}

export function stepUpInvalid(): DomainError {
  return new DomainError('mfa_code_invalid', HttpStatus.UNAUTHORIZED, 'Unauthorized', 'Code de vérification invalide.');
}

/**
 * Code TOTP récent exigé pour les opérations de pouvoir (décision 23) : réseaux de confiance, politique MFA, transfert du
 * principal. La vérification a sa propre transaction, validée avant l'opération : le pas consommé l'est définitivement (un
 * refus métier ultérieur ne le rend pas rejouable) et un échec est audité (`auth.stepup.failed`) avant le 401. Au-delà de
 * 5 échecs en 15 min, l'utilisateur reçoit 429 ; les codes de secours sont refusés.
 */
@Injectable()
export class StepUpService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly checker: MfaCodeChecker,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
  ) {}

  async confirm(principal: Principal, code: string | undefined, precheck: StepUpPrecheck): Promise<void> {
    // L'échec et son audit sont validés (commit) avant de lever l'erreur.
    const outcome = await this.tenantDb.run(async (tx) => {
      await precheck(tx);
      return code ? this.attempt(tx, principal, code) : ({ kind: 'required' } as const);
    });
    if (outcome.kind === 'required') throw stepUpRequired();
    if (outcome.kind === 'invalid') throw stepUpInvalid();
    if (outcome.kind === 'blocked') throw DomainError.tooManyRequests(outcome.retryAfterSeconds);
  }

  private async attempt(tx: TenantTx, principal: Principal, code: string): Promise<Outcome> {
    const factor = await tx.mfaFactor.findFirst({
      where: { userId: principal.userId, kind: TOTP_KIND, activatedAt: { not: null } },
      select: { id: true, secretEnc: true, lastUsedStep: true, userId: true },
    });
    if (!factor) return { kind: 'required' };

    // Essai réservé AVANT la vérification (atomique) : des requêtes parallèles ne dépassent jamais le plafond.
    const key = stepUpKey(principal.tenantId, principal.userId);
    const gate = await this.store.gate(key, STEP_UP_WINDOW_MS, this.clock.now().getTime(), STEP_UP_SCHEDULE, null);
    if (!gate.allowed) return { kind: 'blocked', retryAfterSeconds: Math.ceil(gate.retryAfterMs / SECOND_MS) };

    if (TOTP_CODE.test(code) && (await this.checker.check(tx, principal.tenantId, factor, code))) {
      await this.store.release(key);
      return { kind: 'ok' };
    }
    await this.recordFailure(tx, principal, gate.count);
    return { kind: 'invalid' };
  }

  /** Échec audité sans le code saisi ; le 5e échec ouvre le blocage, tracé à part (aucun type d'alerte dédié n'existe). */
  private async recordFailure(tx: TenantTx, principal: Principal, attempt: number): Promise<void> {
    await this.audit.record(tx, principal.tenantId, { action: 'auth.stepup.failed', outcome: 'failure', actorUserId: principal.userId, changes: { attempt } });
    if (attempt !== STEP_UP_MAX_FAILURES) return;
    await this.audit.record(tx, principal.tenantId, {
      action: 'auth.stepup.locked',
      outcome: 'failure',
      actorUserId: principal.userId,
      changes: { failures: attempt, lockSeconds: STEP_UP_WINDOW_MS / SECOND_MS },
    });
  }
}
