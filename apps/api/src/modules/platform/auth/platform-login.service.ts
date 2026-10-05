import { Injectable } from '@nestjs/common';
import type { PlatformLoginInput, PlatformLoginResponse, PlatformMfaVerifyInput, PlatformTokens } from '@ghmt/shared';
import { PlatformAuditService } from '../../../common/audit/platform-audit.service';
import { PasswordService } from '../../../common/auth/password.service';
import { FieldCrypto } from '../../../common/crypto/field-crypto.service';
import { DomainError } from '../../../common/errors/domain-error';
import { Clock } from '../../../common/time/clock';
import { PlatformDb, type PlatformTx } from '../../../infrastructure/prisma/platform-db.service';
import { hashBackupCode } from '../../auth/services/backup-codes';
import { lockoutAfter } from '../../auth/services/lockout';
import { TotpService } from '../../auth/services/totp.service';
import { PLATFORM_CRYPTO_SCOPE, PLATFORM_MFA_CHALLENGE_TTL_MS, PLATFORM_MFA_MAX_ATTEMPTS } from '../platform.constants';
import { hashPlatformToken, issuePlatformToken } from './platform-opaque-token';
import { PlatformSessionsService } from './platform-sessions.service';

const TOTP_CODE = /^\d{6}$/;

function invalidMfa(): DomainError {
  return new DomainError('invalid_mfa_code', 401, 'Unauthorized', 'Code de vérification invalide ou expiré.');
}

type MfaOutcome = { kind: 'ok'; tokens: PlatformTokens } | { kind: 'rejected' };

/**
 * Connexion du realm plateforme (docs/09 §A1) : mot de passe Argon2id, verrouillage progressif, MFA TOTP OBLIGATOIRE.
 * Sans second facteur enrôlé (enrôlement par le script CLI uniquement), la connexion est refusée (403) ; sinon un challenge est émis.
 * Les échecs sont validés en base (compteur, audit) avant que l'erreur 401 ne soit levée.
 */
@Injectable()
export class PlatformLoginService {
  constructor(
    private readonly platformDb: PlatformDb,
    private readonly passwords: PasswordService,
    private readonly sessions: PlatformSessionsService,
    private readonly totp: TotpService,
    private readonly crypto: FieldCrypto,
    private readonly audit: PlatformAuditService,
    private readonly clock: Clock,
  ) {}

  async login(input: PlatformLoginInput): Promise<PlatformLoginResponse> {
    const now = this.clock.now();
    const user = await this.platformDb.run((tx) => tx.platformUser.findUnique({ where: { email: input.email } }));
    // Même coût (hash factice) pour un compte inconnu : pas d'énumération des comptes.
    const passwordValid = await this.passwords.verify(user?.passwordHash, input.password);
    const locked = !!user?.lockedUntil && user.lockedUntil > now;
    const usable = !!user && user.status === 'active' && !locked;

    if (!user || !usable || !passwordValid) {
      await this.recordFailure(user?.id, user ? (locked ? 'locked' : user.status !== 'active' ? 'inactive' : 'bad_password') : 'unknown_user', now, !!user && usable);
      throw DomainError.invalidCredentials();
    }

    // Sans second facteur enrôlé (par le script CLI), aucune session n'est ouverte : lire le mot de passe ne suffit jamais à
    // prendre un compte jamais enrôlé (revue sécurité M2). Le refus est audité et validé avant l'erreur.
    if (!user.mfaActivatedAt) {
      await this.platformDb.run((tx) =>
        this.audit.record(tx, {
          action: 'platform.auth.login_refused',
          actor: { type: 'platform_user', userId: user.id, role: user.role },
          outcome: 'denied',
          changes: { reason: 'mfa_not_enrolled' },
        }),
      );
      throw DomainError.forbidden('mfa_enrollment_required_cli', 'Second facteur non enrôlé : demandez l’enrôlement par le script d’administration.');
    }

    const rehash = this.passwords.needsRehash(user.passwordHash) ? await this.passwords.hash(input.password) : undefined;
    return this.platformDb.run(async (tx) => {
      if (rehash) await tx.platformUser.update({ where: { id: user.id }, data: { passwordHash: rehash } });
      return this.createChallenge(tx, user.id, now);
    });
  }

  async verifyMfa(input: PlatformMfaVerifyInput): Promise<PlatformTokens> {
    const hash = hashPlatformToken(input.challengeId);
    if (!hash) throw invalidMfa();
    const now = this.clock.now();
    const outcome = await this.platformDb.run((tx) => this.attemptMfa(tx, hash, input.code, now));
    if (outcome.kind !== 'ok') throw invalidMfa();
    return outcome.tokens;
  }

  private async attemptMfa(tx: PlatformTx, tokenHash: Uint8Array<ArrayBuffer>, code: string, now: Date): Promise<MfaOutcome> {
    const challenge = await tx.platformMfaChallenge.findUnique({ where: { tokenHash } });
    if (!challenge || challenge.consumedAt || challenge.expiresAt <= now) return { kind: 'rejected' };
    // Essai réservé AVANT la vérification : des requêtes parallèles ne dépassent jamais 5 essais.
    const reserved = await tx.platformMfaChallenge.updateMany({
      where: { id: challenge.id, consumedAt: null, attempts: { lt: PLATFORM_MFA_MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (reserved.count === 0) return { kind: 'rejected' };

    const user = await tx.platformUser.findUnique({ where: { id: challenge.userId } });
    const locked = !!user?.lockedUntil && user.lockedUntil > now;
    if (!user || user.status !== 'active' || locked || !user.mfaActivatedAt || !user.mfaSecretEnc) return { kind: 'rejected' };

    const method = await this.checkCode(tx, user, code, now);
    if (!method) {
      await this.registerFailedAttempt(tx, user.id, now);
      await this.audit.record(tx, {
        action: 'platform.auth.mfa_failed',
        actor: { type: 'platform_user', userId: user.id, role: user.role },
        outcome: 'failure',
        changes: { attempt: challenge.attempts + 1 },
      });
      return { kind: 'rejected' };
    }
    const consumed = await tx.platformMfaChallenge.updateMany({ where: { id: challenge.id, consumedAt: null }, data: { consumedAt: now } });
    if (consumed.count === 0) return { kind: 'rejected' };

    await tx.platformUser.update({ where: { id: user.id }, data: { failedAttempts: 0, lockedUntil: null, lastLoginAt: now } });
    const tokens = await this.sessions.open(tx, { userId: user.id, role: user.role, mfaVerified: true, mfaEnrolled: true, now });
    await this.audit.record(tx, {
      action: 'platform.auth.login',
      actor: { type: 'platform_user', userId: user.id, role: user.role },
      resourceType: 'platform_session',
      resourceId: tokens.sessionId,
      changes: { method, mfa: true },
    });
    return { kind: 'ok', tokens: stripSession(tokens) };
  }

  /** Code TOTP (anti-rejeu : pas strictement croissant) ou code de secours à usage unique. */
  private async checkCode(
    tx: PlatformTx,
    user: { id: string; mfaSecretEnc: Uint8Array | null; mfaLastUsedStep: bigint | null },
    code: string,
    now: Date,
  ): Promise<'totp' | 'backup_code' | undefined> {
    if (TOTP_CODE.test(code)) {
      const secret = this.crypto.decrypt(PLATFORM_CRYPTO_SCOPE, user.mfaSecretEnc!);
      const result = await this.totp.verify(secret, code, {
        lastUsedStep: user.mfaLastUsedStep === null ? null : Number(user.mfaLastUsedStep),
        nowMs: now.getTime(),
      });
      if (!result.valid) return undefined;
      const claimed = await tx.platformUser.updateMany({
        where: { id: user.id, OR: [{ mfaLastUsedStep: null }, { mfaLastUsedStep: { lt: BigInt(result.step) } }] },
        data: { mfaLastUsedStep: BigInt(result.step) },
      });
      return claimed.count === 1 ? 'totp' : undefined;
    }
    const hash = hashBackupCode(user.id, code);
    const removed = await tx.$executeRaw`
      UPDATE platform.platform_users SET mfa_backup_code_hashes = array_remove(mfa_backup_code_hashes, ${hash})
      WHERE id = ${user.id}::uuid AND ${hash} = ANY (mfa_backup_code_hashes)`;
    return removed === 1 ? 'backup_code' : undefined;
  }

  private async createChallenge(tx: PlatformTx, userId: string, now: Date): Promise<PlatformLoginResponse> {
    const issued = issuePlatformToken();
    const meta = this.sessions.clientMeta();
    await tx.platformMfaChallenge.create({
      data: {
        userId,
        tokenHash: issued.hash,
        expiresAt: new Date(now.getTime() + PLATFORM_MFA_CHALLENGE_TTL_MS),
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
    });
    await this.audit.record(tx, { action: 'platform.auth.mfa_challenge', actor: { type: 'anonymous' }, resourceType: 'platform_user', resourceId: userId });
    return { mfaRequired: true, challengeId: issued.token, methods: ['totp', 'backup_code'] };
  }

  /** Échec : compteur et audit dans une même transaction ; jamais d'e-mail en clair dans le journal. */
  private recordFailure(userId: string | undefined, reason: string, now: Date, countAttempt: boolean): Promise<void> {
    return this.platformDb.run(async (tx) => {
      let lockedUntil: Date | null = null;
      // Un compte déjà verrouillé ou désactivé n'accumule plus d'échecs : le verrou ne se prolonge pas indéfiniment.
      if (userId && countAttempt) lockedUntil = await this.registerFailedAttempt(tx, userId, now);
      await this.audit.record(tx, {
        action: 'platform.auth.login_failed',
        actor: userId ? { type: 'platform_user', userId, role: 'unknown' } : { type: 'anonymous' },
        outcome: 'failure',
        changes: { reason, locked: lockedUntil !== null },
      });
    });
  }

  private async registerFailedAttempt(tx: PlatformTx, userId: string, now: Date): Promise<Date | null> {
    const { failedAttempts } = await tx.platformUser.update({
      where: { id: userId },
      data: { failedAttempts: { increment: 1 } },
      select: { failedAttempts: true },
    });
    const lockedUntil = lockoutAfter(failedAttempts, now);
    if (lockedUntil) await tx.platformUser.update({ where: { id: userId }, data: { lockedUntil } });
    return lockedUntil;
  }
}

function stripSession(tokens: PlatformTokens & { sessionId: string }): PlatformTokens {
  const { sessionId: _sessionId, ...rest } = tokens;
  return rest;
}
