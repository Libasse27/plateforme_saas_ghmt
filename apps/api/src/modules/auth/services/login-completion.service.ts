import { Injectable } from '@nestjs/common';
import type { SessionTokens } from '@ghmt/shared';
import { AuditService } from '../../../common/audit/audit.service';
import { AuthorizationService } from '../../../common/authz/authorization.service';
import { mfaRequiredFor } from '../../../common/authz/clinical-mfa';
import { Clock } from '../../../common/time/clock';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { clearFailedAttempts } from './failed-attempts';
import { touchLastSeen } from './last-seen';
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

/**
 * Étape finale commune à login (sans MFA) et mfa/verify : session, jetons, audit. La remise à zéro du délai progressif
 * (stockage Redis) revient à l'appelant, après le commit : jamais d'appel Redis dans la transaction.
 */
@Injectable()
export class LoginCompletionService {
  constructor(
    private readonly sessions: SessionService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async complete(tx: TenantTx, params: CompleteLoginParams): Promise<SessionTokens> {
    const { tenantId, userId, method, mfaVerified, mfaEnrolled } = params;
    const now = this.clock.now();

    await clearFailedAttempts(tx, tenantId, userId);
    await tx.user.update({ where: { tenantId_id: { tenantId, id: userId } }, data: { lastLoginAt: now }, select: { id: true } });
    await touchLastSeen(tx, tenantId, userId, now);
    const opened = await this.sessions.open(tx, { tenantId, userId, mfaVerified, now });
    const grants = await this.authz.loadGrants(tx, userId, now);
    const network = await this.authz.loadNetworkPolicy(tx, this.sessions.clientMeta().ip);
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
      mfaRequired: mfaRequiredFor({ grants, mode: network.mode, networkTrusted: network.networkTrusted }),
    };
  }
}
