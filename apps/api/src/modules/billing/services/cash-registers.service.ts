import { Injectable } from '@nestjs/common';
import type { CashRegisterView, CreateCashRegisterInput } from '@ghmt/shared';
import { AuditService } from '../../../common/audit/audit.service';
import { RequestContext } from '../../../common/context/request-context';
import { DomainError } from '../../../common/errors/domain-error';
import { TenantDb } from '../../../infrastructure/prisma/tenant-db.service';
import { loadTenantProfile } from '../../../infrastructure/tenancy/tenant-profile';
import { toCashRegisterView } from '../mappers/billing.mapper';
import { CashierRepository } from '../repositories/cashier.repository';
import { isUniqueViolation, refIssue } from './billing-errors';
import { SiteScopeService } from './site-scope.service';

function codeTaken(): DomainError {
  return DomainError.conflict('cash_register_code_taken', 'Ce code de caisse existe déjà pour ce site.');
}

@Injectable()
export class CashRegistersService {
  constructor(
    private readonly db: TenantDb,
    private readonly repo: CashierRepository,
    private readonly siteScopes: SiteScopeService,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
  ) {}

  list(): Promise<CashRegisterView[]> {
    const { tenantId } = this.context.requirePrincipal();
    return this.db.run(async (tx) => {
      const scope = await this.siteScopes.resolve(tx, tenantId, 'cashier:cash_session:read');
      return (await this.repo.listRegisters(tx, tenantId, scope.filter)).map(toCashRegisterView);
    });
  }

  async create(input: CreateCashRegisterInput): Promise<CashRegisterView> {
    const { tenantId, userId } = this.context.requirePrincipal();
    try {
      return await this.db.run(async (tx) => {
        const scope = await this.siteScopes.resolve(tx, tenantId, 'cashier:cash_session:validate');
        if (!scope.includes(input.siteId)) {
          throw DomainError.forbidden('site_out_of_scope', 'Ce site est hors de votre périmètre.', 'cashier:cash_session:validate');
        }
        if (!(await this.repo.siteExists(tx, tenantId, input.siteId))) throw refIssue('siteId', 'Site introuvable.');
        if (await this.repo.registerCodeExists(tx, tenantId, input.siteId, input.code)) throw codeTaken();
        const profile = await loadTenantProfile(tx);
        const row = await this.repo.createRegister(tx, {
          tenantId,
          siteId: input.siteId,
          code: input.code,
          name: input.name,
          currency: input.currency ?? profile.baseCurrency,
          createdBy: userId,
        });
        await this.audit.record(tx, tenantId, {
          action: 'cash_register.created',
          resourceType: 'cash_register',
          resourceId: row.id,
          changes: { siteId: row.siteId, code: row.code, currency: row.currency },
        });
        return toCashRegisterView(row);
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) throw codeTaken();
      throw error;
    }
  }
}
