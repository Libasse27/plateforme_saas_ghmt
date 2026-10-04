import { Injectable } from '@nestjs/common';
import type { TotpActivateResponse, TotpSetupResponse } from '@ghmt/shared';
import { AuditService } from '../../../common/audit/audit.service';
import type { Principal } from '../../../common/context/request-context';
import { FieldCrypto } from '../../../common/crypto/field-crypto.service';
import { DomainError } from '../../../common/errors/domain-error';
import { TenantDb } from '../../../infrastructure/prisma/tenant-db.service';
import { TOTP_KIND } from '../auth.constants';
import { generateBackupCodes, hashBackupCode } from './backup-codes';
import { SessionService } from './session.service';
import { TotpService } from './totp.service';

@Injectable()
export class MfaEnrollmentService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly totp: TotpService,
    private readonly crypto: FieldCrypto,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
  ) {}

  /** Génère un secret chiffré dans un facteur non activé (un enrôlement abandonné est remplacé). */
  async setup(principal: Principal): Promise<TotpSetupResponse> {
    const { tenantId, userId } = principal;
    const secret = this.totp.generateSecret();
    const secretEnc = this.crypto.encrypt(tenantId, secret);

    const email = await this.tenantDb.run(async (tx) => {
      const existing = await tx.mfaFactor.findUnique({ where: { tenantId_userId_kind: { tenantId, userId, kind: TOTP_KIND } } });
      if (existing?.activatedAt) throw DomainError.conflict('mfa_already_enrolled', 'Un second facteur est déjà activé.');
      await tx.mfaFactor.upsert({
        where: { tenantId_userId_kind: { tenantId, userId, kind: TOTP_KIND } },
        create: { tenantId, userId, kind: TOTP_KIND, secretEnc },
        update: { secretEnc, lastUsedStep: null, backupCodeHashes: [] },
      });
      const user = await tx.user.findUniqueOrThrow({ where: { tenantId_id: { tenantId, id: userId } }, select: { email: true } });
      await this.audit.record(tx, tenantId, { action: 'auth.mfa.setup_started', resourceType: 'mfa_factor' });
      return user.email;
    });
    return { otpauthUrl: this.totp.buildUri(secret, email), secret };
  }

  /** Active le facteur, renvoie les codes de secours (une seule fois) et un jeton d'accès mfa=true. */
  async activate(principal: Principal, code: string): Promise<TotpActivateResponse> {
    const { tenantId, userId, sessionId } = principal;
    const now = new Date();

    const backupCodes = await this.tenantDb.run(async (tx) => {
      const factor = await tx.mfaFactor.findUnique({ where: { tenantId_userId_kind: { tenantId, userId, kind: TOTP_KIND } } });
      if (!factor || factor.activatedAt) throw DomainError.unprocessable('mfa_not_pending', 'Aucun enrôlement en cours.');

      const result = await this.totp.verify(this.crypto.decrypt(tenantId, factor.secretEnc), code);
      if (!result.valid) throw DomainError.unprocessable('invalid_code', 'Code de vérification invalide.');

      const codes = generateBackupCodes();
      const activated = await tx.mfaFactor.updateMany({
        where: { tenantId, id: factor.id, activatedAt: null },
        data: {
          activatedAt: now,
          lastUsedStep: BigInt(result.step),
          backupCodeHashes: codes.map((c) => hashBackupCode(userId, c)),
        },
      });
      if (activated.count === 0) throw DomainError.unprocessable('mfa_not_pending', 'Aucun enrôlement en cours.');
      await tx.session.update({ where: { tenantId_id: { tenantId, id: sessionId } }, data: { mfaVerifiedAt: now }, select: { id: true } });
      await this.audit.record(tx, tenantId, { action: 'auth.mfa.activated', resourceType: 'mfa_factor', resourceId: factor.id });
      return codes;
    });

    const accessToken = await this.sessions.signAccessToken({ ...principal, mfa: true });
    return { accessToken, expiresIn: this.sessions.accessTokenTtlSeconds, backupCodes };
  }
}
