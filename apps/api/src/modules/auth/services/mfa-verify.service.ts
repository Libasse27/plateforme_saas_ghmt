import { Injectable } from '@nestjs/common';
import type { MfaVerifyInput, SessionTokens } from '@ghmt/shared';
import { AuditService } from '../../../common/audit/audit.service';
import { FieldCrypto } from '../../../common/crypto/field-crypto.service';
import { DomainError } from '../../../common/errors/domain-error';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { MFA_CHALLENGE_MAX_ATTEMPTS, TOTP_KIND } from '../auth.constants';
import { hashBackupCode } from './backup-codes';
import { registerFailedAttempt } from './lockout';
import { LoginCompletionService, type LoginMethod } from './login-completion.service';
import { parseOpaqueToken } from '../../../common/auth/opaque-token';
import { TotpService } from './totp.service';

type Outcome = { kind: 'ok'; tokens: SessionTokens } | { kind: 'invalid' } | { kind: 'wrong_code' };

interface FactorSnapshot {
  readonly id: string;
  readonly secretEnc: Uint8Array;
  readonly lastUsedStep: bigint | null;
  readonly userId: string;
}

const TOTP_CODE = /^\d{6}$/;

function invalidMfa(): DomainError {
  return new DomainError('invalid_mfa_code', 401, 'Unauthorized', 'Code de vérification invalide ou expiré.');
}

@Injectable()
export class MfaVerifyService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly totp: TotpService,
    private readonly crypto: FieldCrypto,
    private readonly audit: AuditService,
    private readonly completion: LoginCompletionService,
  ) {}

  async verify(input: MfaVerifyInput): Promise<SessionTokens> {
    const parsed = parseOpaqueToken(input.challengeId);
    if (!parsed) throw invalidMfa();

    // Les essais, l'échec et l'audit sont validés (commit) avant de lever l'erreur 401.
    const outcome = await this.tenantDb.runAs(parsed.tenantId, (tx) => this.attempt(tx, parsed.tenantId, parsed.hash, input.code));
    if (outcome.kind !== 'ok') throw invalidMfa();
    return outcome.tokens;
  }

  private async attempt(tx: TenantTx, tenantId: string, tokenHash: Uint8Array<ArrayBuffer>, code: string): Promise<Outcome> {
    const now = new Date();
    const challenge = await tx.mfaChallenge.findUnique({ where: { tenantId_tokenHash: { tenantId, tokenHash } } });
    if (!challenge || challenge.consumedAt || challenge.expiresAt <= now) return { kind: 'invalid' };

    // Essai réservé AVANT la vérification : des requêtes parallèles ne dépassent jamais 5 essais.
    const reserved = await tx.mfaChallenge.updateMany({
      where: { tenantId, id: challenge.id, consumedAt: null, attempts: { lt: MFA_CHALLENGE_MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (reserved.count === 0) return { kind: 'invalid' };

    const userId = challenge.userId;
    const user = await tx.user.findUnique({
      where: { tenantId_id: { tenantId, id: userId } },
      select: {
        status: true,
        deletedAt: true,
        credential: { select: { lockedUntil: true } },
        mfaFactors: { where: { kind: TOTP_KIND, activatedAt: { not: null } }, select: { id: true, secretEnc: true, lastUsedStep: true, userId: true } },
      },
    });
    const factor = user?.mfaFactors[0];
    const locked = user?.credential?.lockedUntil && user.credential.lockedUntil > now;
    if (!user || !factor || user.status !== 'active' || user.deletedAt || locked) return { kind: 'invalid' };

    const method = await this.checkCode(tx, tenantId, factor, code);
    if (!method) {
      await registerFailedAttempt(tx, tenantId, userId, now);
      await this.audit.record(tx, tenantId, {
        action: 'auth.mfa.failed',
        outcome: 'failure',
        actorUserId: userId,
        changes: { attempt: challenge.attempts + 1 },
      });
      return { kind: 'wrong_code' };
    }

    const consumed = await tx.mfaChallenge.updateMany({ where: { tenantId, id: challenge.id, consumedAt: null }, data: { consumedAt: now } });
    if (consumed.count === 0) return { kind: 'invalid' };
    const tokens = await this.completion.complete(tx, { tenantId, userId, method, mfaVerified: true, mfaEnrolled: true });
    return { kind: 'ok', tokens };
  }

  /** Retourne la méthode validée, ou undefined. La consommation est atomique (anti-rejeu, usage unique). */
  private async checkCode(tx: TenantTx, tenantId: string, factor: FactorSnapshot, code: string): Promise<LoginMethod | undefined> {
    if (TOTP_CODE.test(code)) {
      const secret = this.crypto.decrypt(tenantId, factor.secretEnc);
      const result = await this.totp.verify(secret, code, { lastUsedStep: factor.lastUsedStep === null ? null : Number(factor.lastUsedStep) });
      if (!result.valid) return undefined;
      const claimed = await tx.mfaFactor.updateMany({
        where: { tenantId, id: factor.id, OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: BigInt(result.step) } }] },
        data: { lastUsedStep: BigInt(result.step) },
      });
      return claimed.count === 1 ? 'totp' : undefined;
    }

    const hash = hashBackupCode(factor.userId, code);
    const removed = await tx.$executeRaw`
      UPDATE tenant.mfa_factors
      SET backup_code_hashes = array_remove(backup_code_hashes, ${hash})
      WHERE tenant_id = ${tenantId}::uuid AND id = ${factor.id}::uuid AND ${hash} = ANY (backup_code_hashes)`;
    return removed === 1 ? 'backup_code' : undefined;
  }
}
