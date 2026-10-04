import { Injectable } from '@nestjs/common';
import type { SignupResponse, SignupTenantInput } from '@ghmt/shared';
import { PasswordService } from '../../../common/auth/password.service';
import { DomainError } from '../../../common/errors/domain-error';
import { TenantDb } from '../../../infrastructure/prisma/tenant-db.service';
import { TenantProvisioningService } from '../../../infrastructure/tenancy/tenant-provisioning.service';

const UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; meta?: { code?: string; driverAdapterError?: { cause?: { originalCode?: string } } } };
  return e?.code === 'P2002' || (e?.meta?.driverAdapterError?.cause?.originalCode ?? e?.meta?.code) === UNIQUE_VIOLATION;
}

@Injectable()
export class SignupService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly passwords: PasswordService,
    private readonly provisioning: TenantProvisioningService,
  ) {}

  /** Crée l'établissement et son administrateur. Pas de connexion automatique. */
  async signup(input: SignupTenantInput): Promise<SignupResponse> {
    const slug = input.establishment.slug;
    if (await this.slugExists(slug)) throw this.slugTaken();

    const passwordHash = await this.passwords.hash(input.admin.password);
    try {
      const provisioned = await this.provisioning.provision(input, passwordHash);
      return { tenantId: provisioned.tenantId, slug };
    } catch (err) {
      // Course entre deux inscriptions sur le même identifiant.
      if (isUniqueViolation(err)) throw this.slugTaken();
      throw err;
    }
  }

  private async slugExists(slug: string): Promise<boolean> {
    const rows = await this.tenantDb.runWithoutTenant((tx) =>
      tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM platform.resolve_tenant(${slug})`,
    );
    return rows.length > 0;
  }

  private slugTaken(): DomainError {
    return DomainError.conflict('slug_taken', 'Cet identifiant d’établissement est déjà utilisé.');
  }
}
