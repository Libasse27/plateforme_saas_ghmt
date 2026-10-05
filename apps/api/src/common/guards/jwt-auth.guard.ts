import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AccessTokenService } from '../auth/access-token.service';
import { RequestContext, type Principal } from '../context/request-context';
import { IS_PUBLIC_KEY } from '../decorators/auth.decorators';
import { PLATFORM_REALM_KEY } from '../decorators/realm.decorators';
import { DomainError } from '../errors/domain-error';
import { TenantDb } from '../../infrastructure/prisma/tenant-db.service';

/** Seul l'en-tête `Authorization: Bearer` authentifie : aucun cookie n'est lu (pas de vecteur CSRF). */
export function extractBearerToken(req: Pick<Request, 'header'>): string | undefined {
  const header = req.header('authorization');
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice('Bearer '.length).trim() || undefined;
}

/**
 * Guard global n°1 (docs/03 §1.4 étape 4) : JWT valide + session active et utilisateur actif.
 * La vérification de session à chaque requête rend la révocation immédiate.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: AccessTokenService,
    private readonly tenantDb: TenantDb,
    private readonly context: RequestContext,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;
    // Realm plateforme : contournement EXPLICITE des guards tenant ; le guard plateforme authentifie ces routes.
    if (this.reflector.getAllAndOverride<boolean>(PLATFORM_REALM_KEY, targets)) return true;

    const req = ctx.switchToHttp().getRequest<Request & { principal?: Principal }>();
    const token = extractBearerToken(req);
    if (!token) throw DomainError.unauthorized();

    const principal = await this.tokens.verify(token);
    const active = await this.tenantDb.runAs(
      principal.tenantId,
      (tx) =>
        tx.session.findFirst({
          where: {
            id: principal.sessionId,
            userId: principal.userId,
            revokedAt: null,
            expiresAt: { gt: new Date() },
            user: { status: 'active', deletedAt: null },
          },
          select: { id: true },
        }),
      principal.userId,
    );
    if (!active) throw DomainError.unauthorized('Session expirée ou révoquée.');

    this.context.setPrincipal(principal);
    req.principal = principal;
    return true;
  }
}
