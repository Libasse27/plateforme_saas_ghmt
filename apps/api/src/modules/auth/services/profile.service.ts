import { Injectable } from '@nestjs/common';
import type { MeResponse } from '@ghmt/shared';
import { AuthorizationService } from '../../../common/authz/authorization.service';
import type { Principal } from '../../../common/context/request-context';
import { DomainError } from '../../../common/errors/domain-error';
import { TenantDb } from '../../../infrastructure/prisma/tenant-db.service';
import { loadTenantProfile } from '../../../infrastructure/tenancy/tenant-profile';
import { TOTP_KIND } from '../auth.constants';

@Injectable()
export class ProfileService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly authz: AuthorizationService,
  ) {}

  /** Profil, permissions effectives (codes), modules actifs et état MFA de l'utilisateur courant. */
  me(principal: Principal): Promise<MeResponse> {
    const { tenantId, userId } = principal;
    return this.tenantDb.run(async (tx) => {
      const user = await tx.user.findUnique({
        where: { tenantId_id: { tenantId, id: userId } },
        select: {
          id: true,
          email: true,
          fullName: true,
          locale: true,
          credential: { select: { mustChangePassword: true } },
          mfaFactors: { where: { kind: TOTP_KIND, activatedAt: { not: null } }, select: { id: true } },
        },
      });
      if (!user) throw DomainError.unauthorized();
      const [grants, tenant, profile] = await Promise.all([
        this.authz.loadGrants(tx, userId),
        this.authz.loadTenantModules(tx),
        loadTenantProfile(tx),
      ]);
      return {
        user: {
          id: user.id,
          email: user.email,
          fullName: user.fullName,
          locale: user.locale,
          mustChangePassword: user.credential?.mustChangePassword ?? false,
        },
        tenant: profile,
        permissions: [...new Set(grants.map((g) => g.permission))].sort(),
        modules: [...tenant.modules].sort(),
        mfa: {
          enrolled: user.mfaFactors.length > 0,
          verified: principal.mfa,
          required: grants.some((g) => g.mfaRequired),
        },
      };
    });
  }
}
