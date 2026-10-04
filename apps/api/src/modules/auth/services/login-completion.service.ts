import { Injectable } from '@nestjs/common';
import type { SessionTokens } from '@ghmt/shared';
import { AuditService } from '../../../common/audit/audit.service';
import { AuthorizationService } from '../../../common/authz/authorization.service';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { clearFailedAttempts } from './lockout';
import { SessionService } from './session.service';

export type LoginMethod = 'password' | 'totp' | 'backup_code';

export interface CompleteLoginParams {
  readonly tenantId: string;
  readonly userId: string;
  readonly method: LoginMethod;
  /** Second facteur vérifié pendant ce login. */
  readonly mfaVerified: boolean;
  readonly mfaEnrolled: boolean;
}

/** Étape finale commune à login (sans MFA) et mfa/verify : session, jetons, audit. */
@Injectable()
export class LoginCompletionService {
  constructor(
    private readonly sessions: SessionService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  async complete(tx: TenantTx, params: CompleteLoginParams): Promise<SessionTokens> {
    const { tenantId, userId, method, mfaVerified, mfaEnrolled } = params;
    const now = new Date();

    await clearFailedAttempts(tx, tenantId, userId);
    await tx.user.update({ where: { tenantId_id: { tenantId, id: userId } }, data: { lastLoginAt: now }, select: { id: true } });
    const opened = await this.sessions.open(tx, { tenantId, userId, mfaVerified, now });
    const grants = await this.authz.loadGrants(tx, userId, now);
    await this.audit.record(tx, tenantId, {
      action: 'auth.login.success',
      actorUserId: userId,
      resourceType: 'session',
      resourceId: opened.sessionId,
      changes: { method, mfa: mfaVerified },
    });

    const accessToken = await this.sessions.signAccessToken({ tenantId, userId, sessionId: opened.sessionId, mfa: mfaVerified });
    return {
      accessToken,
      refreshToken: opened.refreshToken,
      expiresIn: this.sessions.accessTokenTtlSeconds,
      mfaEnrolled,
      mfaRequired: grants.some((grant) => grant.mfaRequired),
    };
  }
}
