import { Injectable } from '@nestjs/common';
import type { LoginInput, LoginResponse } from '@ghmt/shared';
import { PasswordService } from '../../../common/auth/password.service';
import { AuditService } from '../../../common/audit/audit.service';
import { DomainError } from '../../../common/errors/domain-error';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { MFA_CHALLENGE_TTL_MS, TOTP_KIND } from '../auth.constants';
import { LoginCompletionService } from './login-completion.service';
import { registerFailedAttempt } from './lockout';
import { issueOpaqueToken } from '../../../common/auth/opaque-token';
import { SessionService } from './session.service';

interface ResolvedTenant {
  readonly id: string;
  readonly status: string;
}

type FailureReason = 'unknown_user' | 'bad_password' | 'locked' | 'inactive';

interface LoadedUser {
  readonly id: string;
  readonly status: string;
  readonly deletedAt: Date | null;
  readonly credential: { passwordHash: string; lockedUntil: Date | null } | null;
  readonly hasMfaFactor: boolean;
}

@Injectable()
export class LoginService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly completion: LoginCompletionService,
  ) {}

  async login(input: LoginInput): Promise<LoginResponse> {
    const now = new Date();
    const tenant = await this.resolveTenant(input.tenantSlug);
    if (!tenant || tenant.status !== 'active') {
      // Même coût (Argon2id factice) et même réponse que pour un mauvais mot de passe : pas d'énumération.
      await this.passwords.verify(undefined, input.password);
      throw DomainError.invalidCredentials();
    }

    const user = await this.loadUser(tenant.id, input.email);
    const reason = this.rejectionReason(user, now);
    const passwordValid = await this.passwords.verify(user?.credential?.passwordHash, input.password);

    if (!user || reason || !passwordValid) {
      await this.recordFailure(tenant.id, user, reason ?? (user ? 'bad_password' : 'unknown_user'), now);
      throw DomainError.invalidCredentials();
    }

    const rehash = this.passwords.needsRehash(user.credential!.passwordHash) ? await this.passwords.hash(input.password) : undefined;
    return this.tenantDb.runAs(
      tenant.id,
      async (tx) => {
        if (rehash) {
          await tx.userCredential.update({
            where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } },
            data: { passwordHash: rehash },
          });
        }
        if (user.hasMfaFactor) return this.createChallenge(tx, tenant.id, user.id);
        return this.completion.complete(tx, {
          tenantId: tenant.id,
          userId: user.id,
          method: 'password',
          mfaVerified: false,
          mfaEnrolled: false,
        });
      },
      user.id,
    );
  }

  private async resolveTenant(slug: string): Promise<ResolvedTenant | undefined> {
    const rows = await this.tenantDb.runWithoutTenant((tx) =>
      tx.$queryRaw<ResolvedTenant[]>`SELECT id::text AS id, status::text AS status FROM platform.resolve_tenant(${slug})`,
    );
    return rows[0];
  }

  private loadUser(tenantId: string, email: string): Promise<LoadedUser | undefined> {
    return this.tenantDb.runAs(tenantId, async (tx) => {
      const user = await tx.user.findUnique({
        where: { tenantId_email: { tenantId, email } },
        select: {
          id: true,
          status: true,
          deletedAt: true,
          credential: { select: { passwordHash: true, lockedUntil: true } },
          mfaFactors: { where: { kind: TOTP_KIND, activatedAt: { not: null } }, select: { id: true } },
        },
      });
      return user ? { ...user, hasMfaFactor: user.mfaFactors.length > 0 } : undefined;
    });
  }

  private rejectionReason(user: LoadedUser | undefined, now: Date): FailureReason | undefined {
    if (!user?.credential) return undefined;
    if (user.status !== 'active' || user.deletedAt) return 'inactive';
    if (user.credential.lockedUntil && user.credential.lockedUntil > now) return 'locked';
    return undefined;
  }

  private async createChallenge(tx: TenantTx, tenantId: string, userId: string): Promise<LoginResponse> {
    const issued = issueOpaqueToken(tenantId);
    const meta = this.sessions.clientMeta();
    await tx.mfaChallenge.create({
      data: {
        tenantId,
        userId,
        tokenHash: issued.hash,
        expiresAt: new Date(Date.now() + MFA_CHALLENGE_TTL_MS),
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
    });
    await this.audit.record(tx, tenantId, { action: 'auth.login.mfa_challenge', actorUserId: userId });
    return { mfaRequired: true, challengeId: issued.token, methods: ['totp', 'backup_code'] };
  }

  /** Échec : compteur et audit dans une même transaction ; jamais d'email en clair dans le journal. */
  private recordFailure(tenantId: string, user: LoadedUser | undefined, reason: FailureReason, now: Date): Promise<void> {
    return this.tenantDb.runAs(tenantId, async (tx) => {
      let lockedUntil: Date | null = null;
      // Un compte déjà verrouillé n'accumule plus d'échecs : le verrou ne se prolonge pas indéfiniment.
      if (user?.credential && reason !== 'locked' && reason !== 'inactive') {
        lockedUntil = await registerFailedAttempt(tx, tenantId, user.id, now);
      }
      await this.audit.record(tx, tenantId, {
        action: 'auth.login.failed',
        outcome: 'failure',
        actorType: user ? 'user' : 'anonymous',
        ...(user ? { actorUserId: user.id } : {}),
        changes: { reason, locked: lockedUntil !== null },
      });
    }, user?.id);
  }
}
