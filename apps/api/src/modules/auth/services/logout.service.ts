import { Injectable } from '@nestjs/common';
import { AccessTokenService } from '../../../common/auth/access-token.service';
import { parseOpaqueToken } from '../../../common/auth/opaque-token';
import { AuditService } from '../../../common/audit/audit.service';
import { DomainError } from '../../../common/errors/domain-error';
import { TenantDb } from '../../../infrastructure/prisma/tenant-db.service';

/**
 * Déconnexion publique (C8) : le jeton de rafraîchissement suffit à révoquer sa session,
 * même quand le jeton d'accès a expiré. Réponse identique (204) que le jeton soit connu ou non.
 */
@Injectable()
export class LogoutService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly tokens: AccessTokenService,
    private readonly audit: AuditService,
  ) {}

  async logout(params: { refreshToken?: string; accessToken?: string }): Promise<void> {
    if (params.refreshToken) return this.logoutByRefreshToken(params.refreshToken);
    if (!params.accessToken) throw DomainError.unauthorized();
    // Jeton d'accès invalide ⇒ 401 ; session déjà révoquée ⇒ opération idempotente.
    const principal = await this.tokens.verify(params.accessToken);
    await this.revoke(principal.tenantId, { id: principal.sessionId, userId: principal.userId });
  }

  private async logoutByRefreshToken(rawToken: string): Promise<void> {
    const parsed = parseOpaqueToken(rawToken);
    if (!parsed) return;
    const session = await this.tenantDb.runAs(parsed.tenantId, (tx) =>
      tx.refreshToken.findUnique({
        where: { tenantId_tokenHash: { tenantId: parsed.tenantId, tokenHash: parsed.hash } },
        select: { session: { select: { id: true, userId: true } } },
      }),
    );
    if (session) await this.revoke(parsed.tenantId, session.session);
  }

  private async revoke(tenantId: string, session: { id: string; userId: string }): Promise<void> {
    await this.tenantDb.runAs(
      tenantId,
      async (tx) => {
        const { count } = await tx.session.updateMany({
          where: { id: session.id, userId: session.userId, revokedAt: null },
          data: { revokedAt: new Date(), revokedReason: 'logout' },
        });
        if (count === 0) return;
        await this.audit.record(tx, tenantId, {
          action: 'auth.logout',
          actorUserId: session.userId,
          resourceType: 'session',
          resourceId: session.id,
        });
      },
      session.userId,
    );
  }
}
