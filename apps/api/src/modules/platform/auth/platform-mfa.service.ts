import { Injectable } from '@nestjs/common';
import type { TotpActivateResponse, TotpSetupResponse } from '@ghmt/shared';
import { PlatformAuditService } from '../../../common/audit/platform-audit.service';
import { FieldCrypto } from '../../../common/crypto/field-crypto.service';
import { DomainError } from '../../../common/errors/domain-error';
import { Clock } from '../../../common/time/clock';
import { PlatformDb } from '../../../infrastructure/prisma/platform-db.service';
import { generateBackupCodes, hashBackupCode } from '../../auth/services/backup-codes';
import { TotpService } from '../../auth/services/totp.service';
import { PLATFORM_CRYPTO_SCOPE } from '../platform.constants';
import type { PlatformPrincipal } from './platform-auth.guard';
import { PlatformSessionsService } from './platform-sessions.service';

/** Enrôlement TOTP obligatoire du realm plateforme (secret chiffré AES-256-GCM, codes de secours hachés). */
@Injectable()
export class PlatformMfaService {
  constructor(
    private readonly platformDb: PlatformDb,
    private readonly totp: TotpService,
    private readonly crypto: FieldCrypto,
    private readonly audit: PlatformAuditService,
    private readonly sessions: PlatformSessionsService,
    private readonly clock: Clock,
  ) {}

  /** Génère un secret chiffré, non actif tant que `activate` n'a pas validé un code (un enrôlement abandonné est remplacé). */
  async setup(principal: PlatformPrincipal): Promise<TotpSetupResponse> {
    const secret = this.totp.generateSecret();
    const email = await this.platformDb.run(async (tx) => {
      const user = await tx.platformUser.findUniqueOrThrow({ where: { id: principal.userId } });
      if (user.mfaActivatedAt) throw DomainError.conflict('mfa_already_enrolled', 'Un second facteur est déjà activé.');
      await tx.platformUser.update({
        where: { id: user.id },
        data: { mfaSecretEnc: this.crypto.encrypt(PLATFORM_CRYPTO_SCOPE, secret), mfaLastUsedStep: null, mfaBackupHashes: [] },
      });
      await this.audit.record(tx, {
        action: 'platform.auth.mfa_setup_started',
        actor: { type: 'platform_user', userId: user.id, role: user.role },
      });
      return user.email;
    });
    return { otpauthUrl: this.totp.buildUri(secret, email), secret };
  }

  /** Active le facteur, renvoie les codes de secours (une seule fois) et un jeton d'accès `mfa: true`. */
  async activate(principal: PlatformPrincipal, code: string): Promise<TotpActivateResponse> {
    const now = this.clock.now();
    const backupCodes = await this.platformDb.run(async (tx) => {
      const user = await tx.platformUser.findUniqueOrThrow({ where: { id: principal.userId } });
      if (user.mfaActivatedAt || !user.mfaSecretEnc) throw DomainError.unprocessable('mfa_not_pending', 'Aucun enrôlement en cours.');
      const result = await this.totp.verify(this.crypto.decrypt(PLATFORM_CRYPTO_SCOPE, user.mfaSecretEnc), code, { nowMs: now.getTime() });
      if (!result.valid) throw DomainError.unprocessable('invalid_code', 'Code de vérification invalide.');

      const codes = generateBackupCodes();
      const activated = await tx.platformUser.updateMany({
        where: { id: user.id, mfaActivatedAt: null },
        data: { mfaActivatedAt: now, mfaLastUsedStep: BigInt(result.step), mfaBackupHashes: codes.map((c) => hashBackupCode(user.id, c)) },
      });
      if (activated.count === 0) throw DomainError.unprocessable('mfa_not_pending', 'Aucun enrôlement en cours.');
      await tx.platformSession.update({ where: { id: principal.sessionId }, data: { mfaVerifiedAt: now } });
      await this.audit.record(tx, {
        action: 'platform.auth.mfa_activated',
        actor: { type: 'platform_user', userId: user.id, role: user.role },
      });
      return codes;
    });
    const accessToken = await this.sessions.signAccessToken(principal.userId, principal.sessionId, principal.role, true);
    return { accessToken, expiresIn: this.sessions.accessTokenTtlSeconds, backupCodes };
  }
}
