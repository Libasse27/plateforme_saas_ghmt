import { Injectable } from '@nestjs/common';
import { FieldCrypto } from '../../../common/crypto/field-crypto.service';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { hashBackupCode } from './backup-codes';
import type { LoginMethod } from './login-completion.service';
import { TotpService } from './totp.service';

export interface FactorSnapshot {
  readonly id: string;
  readonly secretEnc: Uint8Array;
  readonly lastUsedStep: bigint | null;
  readonly userId: string;
}

const TOTP_CODE = /^\d{6}$/;

/**
 * Vérification d'un code de second facteur (TOTP ou code de secours), partagée par `mfa/verify` et la réinitialisation
 * du mot de passe. La consommation est atomique : anti-rejeu du pas TOTP, usage unique d'un code de secours.
 */
@Injectable()
export class MfaCodeChecker {
  constructor(
    private readonly totp: TotpService,
    private readonly crypto: FieldCrypto,
  ) {}

  /** Retourne la méthode validée, ou undefined. */
  async check(tx: TenantTx, tenantId: string, factor: FactorSnapshot, code: string): Promise<LoginMethod | undefined> {
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
