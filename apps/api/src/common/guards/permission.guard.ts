import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PermissionKey } from '@ghmt/shared';
import { AuditService } from '../audit/audit.service';
import { AuthorizationService, evaluateAuthorization } from '../authz/authorization.service';
import { RequestContext } from '../context/request-context';
import { IS_AUTHENTICATED_ONLY_KEY, IS_PUBLIC_KEY, PERMISSIONS_KEY } from '../decorators/auth.decorators';
import { DomainError } from '../errors/domain-error';
import { TenantDb } from '../../infrastructure/prisma/tenant-db.service';

const DENY_MESSAGES: Record<string, string> = {
  tenant_inactive: 'L’établissement n’est pas actif.',
  subscription_suspended: 'Abonnement suspendu : accès en lecture seule.',
  module_not_enabled: 'Ce module n’est pas activé pour votre établissement.',
  permission_denied: 'Action non autorisée.',
  mfa_enrollment_required: 'L’authentification à deux facteurs est obligatoire pour votre rôle.',
  password_change_required: 'Vous devez changer votre mot de passe avant de continuer.',
};

/**
 * Guard global n°2 (docs/04 §3.8, docs/03 §1.4 étapes 5-6) : module activé + permission + MFA.
 * Refus par défaut : une route ni @Public ni @AuthenticatedOnly ni @RequirePermission est interdite.
 * Les refus sont audités (raison détaillée en audit, message générique au client).
 */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authz: AuthorizationService,
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, targets)) return true;
    if (this.reflector.getAllAndOverride<boolean>(IS_AUTHENTICATED_ONLY_KEY, targets)) return true;

    const required = this.reflector.getAllAndOverride<PermissionKey[]>(PERMISSIONS_KEY, targets);
    if (!required?.length) throw DomainError.forbidden();

    const principal = this.context.requirePrincipal();
    const { decision, grants } = await this.tenantDb.run(async (tx) => {
      // Mot de passe à changer : seules les routes @AuthenticatedOnly (dont le changement lui-même) restent accessibles.
      const credential = await tx.userCredential.findUnique({
        where: { tenantId_userId: { tenantId: principal.tenantId, userId: principal.userId } },
        select: { mustChangePassword: true },
      });
      if (credential?.mustChangePassword) return { decision: { allowed: false, reason: 'password_change_required' } as const, grants: [] };

      const [loadedGrants, tenant] = await Promise.all([this.authz.loadGrants(tx, principal.userId), this.authz.loadTenantModules(tx)]);
      const result = evaluateAuthorization({
        required,
        grants: loadedGrants,
        enabledModules: tenant.modules,
        tenantStatus: tenant.status,
        mfaVerified: principal.mfa,
      });
      if (!result.allowed) {
        await this.audit.record(tx, principal.tenantId, {
          action: 'authz.denied',
          outcome: 'denied',
          changes: { reason: result.reason, permission: result.permission ?? null, required },
        });
      }
      return { decision: result, grants: loadedGrants };
    });

    if (!decision.allowed) {
      throw DomainError.forbidden(decision.reason, DENY_MESSAGES[decision.reason], decision.permission);
    }
    this.context.setGrants(grants);
    return true;
  }
}
