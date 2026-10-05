import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { PlatformRole } from '@ghmt/shared';
import { generate } from 'otplib';
import request from 'supertest';
import { PasswordService } from '../../src/common/auth/password.service';
import { FieldCrypto } from '../../src/common/crypto/field-crypto.service';
import { PLATFORM_CRYPTO_SCOPE, PLATFORM_SESSION_TTL_MS } from '../../src/modules/platform/platform.constants';
import { PlatformTokenService } from '../../src/modules/platform/auth/platform-token.service';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { TotpService } from '../../src/modules/auth/services/totp.service';
import { FIXTURE_PASSWORD } from './fixtures';

export const PLATFORM = '/api/v1/platform';

export interface PlatformUserFixture {
  readonly userId: string;
  readonly email: string;
  readonly role: PlatformRole;
  /** Jeton d'accès d'une session dont la MFA est vérifiée. */
  readonly token: string;
  readonly sessionId: string;
  /** Secret TOTP (utilisateur enrôlé uniquement). */
  readonly totpSecret: string | null;
}

export function http(app: INestApplication): ReturnType<typeof request> {
  return request(app.getHttpServer());
}

export function bearer(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

let counter = 0;

/** Adresse cliente distincte par appel (trust proxy) : isole les quotas de débit des routes de connexion. */
export function platformClientIp(): string {
  counter += 1;
  return `172.${(counter >> 16) & 255}.${(counter >> 8) & 255}.${counter & 255}`;
}

export function totpNow(secret: string, offsetSeconds = 0): Promise<string> {
  return generate({ secret, epoch: Math.floor(Date.now() / 1000) + offsetSeconds });
}

/**
 * Crée un utilisateur plateforme directement en base. `enrolled` : second facteur déjà activé (secret connu) ;
 * sinon le compte doit enrôler son TOTP à la première connexion. La session ouverte est « MFA vérifiée » si `mfaSession`.
 */
export async function createPlatformUser(
  app: INestApplication,
  role: PlatformRole = 'super_admin',
  options: { enrolled?: boolean; mfaSession?: boolean; disabled?: boolean } = {},
): Promise<PlatformUserFixture> {
  const enrolled = options.enrolled ?? true;
  const mfaSession = options.mfaSession ?? enrolled;
  const email = `${role}-${randomBytes(4).toString('hex')}@plateforme.test`;
  const passwordHash = await app.get(PasswordService).hash(FIXTURE_PASSWORD);
  const totpSecret = enrolled ? app.get(TotpService).generateSecret() : null;
  const now = new Date();

  const created = await app.get(PlatformDb).run(async (tx) => {
    const user = await tx.platformUser.create({
      data: {
        email,
        passwordHash,
        fullName: `Plateforme ${role}`,
        role,
        status: options.disabled ? 'disabled' : 'active',
        ...(totpSecret ? { mfaSecretEnc: app.get(FieldCrypto).encrypt(PLATFORM_CRYPTO_SCOPE, totpSecret), mfaActivatedAt: now } : {}),
      },
      select: { id: true },
    });
    const session = await tx.platformSession.create({
      data: {
        userId: user.id,
        expiresAt: new Date(now.getTime() + PLATFORM_SESSION_TTL_MS),
        mfaVerifiedAt: mfaSession ? now : null,
      },
      select: { id: true },
    });
    return { userId: user.id, sessionId: session.id };
  });
  const token = await app.get(PlatformTokenService).sign({ userId: created.userId, sessionId: created.sessionId, role, mfa: mfaSession });
  return { ...created, email, role, token, totpSecret };
}
