import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import type { PractitionerRow } from '../mappers/practitioner.mapper';

@Injectable()
export class PractitionersRepository {
  create(tx: TenantTx, data: Prisma.PractitionerUncheckedCreateInput): Promise<PractitionerRow> {
    return tx.practitioner.create({ data });
  }

  findById(tx: TenantTx, tenantId: string, id: string): Promise<PractitionerRow | null> {
    return tx.practitioner.findFirst({ where: { tenantId, id, deletedAt: null } });
  }

  list(tx: TenantTx, tenantId: string, filter: { isBookable?: boolean; afterId?: string; take: number }): Promise<PractitionerRow[]> {
    return tx.practitioner.findMany({
      where: {
        tenantId,
        deletedAt: null,
        ...(filter.isBookable === undefined ? {} : { isBookable: filter.isBookable }),
        ...(filter.afterId ? { id: { gt: filter.afterId } } : {}),
      },
      orderBy: { id: 'asc' },
      take: filter.take,
    });
  }

  async update(tx: TenantTx, tenantId: string, id: string, data: Prisma.PractitionerUncheckedUpdateManyInput): Promise<number> {
    const result = await tx.practitioner.updateMany({
      where: { tenantId, id, deletedAt: null },
      data: { ...data, rowVersion: { increment: 1 } },
    });
    return result.count;
  }

  async userExists(tx: TenantTx, tenantId: string, id: string): Promise<boolean> {
    return (await tx.user.count({ where: { tenantId, id, deletedAt: null } })) > 0;
  }

  async departmentExists(tx: TenantTx, tenantId: string, id: string): Promise<boolean> {
    return (await tx.department.count({ where: { tenantId, id, deletedAt: null } })) > 0;
  }

  async siteExists(tx: TenantTx, tenantId: string, id: string): Promise<boolean> {
    return (await tx.site.count({ where: { tenantId, id, deletedAt: null } })) > 0;
  }
}
