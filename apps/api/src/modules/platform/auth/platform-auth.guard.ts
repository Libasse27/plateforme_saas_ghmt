import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { platformRoleHas, type PlatformPermission, type PlatformRole } from '@ghmt/shared';
import type { Request } from 'express';
import { PlatformAuditService } from '../../../common/audit/platform-audit.service';
import { DomainError } from '../../../common/errors/domain-error';
import { extractBearerToken } from '../../../common/guards/jwt-auth.guard';
import { Clock } from '../../../common/time/clock';
import { PlatformDb } from '../../../infrastructure/prisma/platform-db.service';
import { PLATFORM_AUTH_ONLY_KEY, PLATFORM_PERMISSIONS_KEY, PLATFORM_PUBLIC_KEY } from './platform.keys';
import { PlatformTokenService } from './platform-token.service';

export interface PlatformPrincipal {
  readonly userId: string;
  readonly sessionId: string;
  /** Rôle lu en base à chaque requête (une rétrogradation prend effet immédiatement), jamais le claim du jeton. */
  readonly role: PlatformRole;
  /** Second facteur vérifié : claim du jeton ET session marquée MFA en base. */
  readonly mfa: boolean;
}

export type PlatformRequest = Request & { platformPrincipal?: PlatformPrincipal };

/**
 * Guard du realm plateforme. Refus par défaut : une route plateforme sans `@PlatformPublic`, `@PlatformAuthenticatedOnly`
 * ni `@RequirePlatformPermission` est interdite. Exige la MFA pour toute route métier.
 * Associé à `PlatformRealm` par `@PlatformController()` : les guards tenant laissent passer ces routes, celui-ci les protège.
 */
@Injectable()
export class PlatformAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: PlatformTokenService,
    private readonly platformDb: PlatformDb,
    private readonly audit: PlatformAuditService,
    private readonly clock: Clock,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PLATFORM_PUBLIC_KEY, targets)) return true;

    const req = ctx.switchToHttp().getRequest<PlatformRequest>();
    const token = extractBearerToken(req);
    if (!token) throw DomainError.unauthorized();
    const claims = await this.tokens.verify(token);
    const principal = await this.loadPrincipal(claims.userId, claims.sessionId, claims.mfa);
    req.platformPrincipal = principal;

    if (this.reflector.getAllAndOverride<boolean>(PLATFORM_AUTH_ONLY_KEY, targets)) return true;
    const required = this.reflector.getAllAndOverride<PlatformPermission[]>(PLATFORM_PERMISSIONS_KEY, targets);
    if (!required?.length) throw DomainError.forbidden();
    if (!principal.mfa) await this.deny(principal, 'mfa_enrollment_required', required);

    const missing = required.find((permission) => !platformRoleHas(principal.role, permission));
    if (missing) await this.deny(principal, 'permission_denied', required, missing);
    return true;
  }

  private async loadPrincipal(userId: string, sessionId: string, mfaClaim: boolean): Promise<PlatformPrincipal> {
    const now = this.clock.now();
    const session = await this.platformDb.run((tx) =>
      tx.platformSession.findFirst({
        where: { id: sessionId, userId, revokedAt: null, expiresAt: { gt: now }, user: { status: 'active' } },
        select: { mfaVerifiedAt: true, user: { select: { role: true } } },
      }),
    );
    if (!session) throw DomainError.unauthorized('Session expirée ou révoquée.');
    return { userId, sessionId, role: session.user.role, mfa: mfaClaim && session.mfaVerifiedAt !== null };
  }

  private async deny(principal: PlatformPrincipal, reason: string, required: readonly string[], permission?: string): Promise<never> {
    await this.platformDb.run((tx) =>
      this.audit.record(tx, {
        action: 'platform.authz.denied',
        actor: { type: 'platform_user', userId: principal.userId, role: principal.role },
        outcome: 'denied',
        changes: { reason, required, permission: permission ?? null },
      }),
    );
    throw DomainError.forbidden(
      reason,
      reason === 'mfa_enrollment_required' ? 'L’authentification à deux facteurs est obligatoire.' : 'Action non autorisée.',
      permission,
    );
  }
}
