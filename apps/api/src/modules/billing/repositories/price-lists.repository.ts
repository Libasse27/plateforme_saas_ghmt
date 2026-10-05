import { Injectable } from '@nestjs/common';
import type { ItemCategory } from '@ghmt/shared';
import type { PriceList, PriceListItem, Prisma } from '../../../generated/prisma/client';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';

export interface ItemListCriteria {
  readonly priceListId: string;
  readonly category?: ItemCategory;
  readonly q?: string;
  readonly includeInactive: boolean;
  readonly afterCode?: string;
  readonly take: number;
}

@Injectable()
export class PriceListsRepository {
  list(tx: TenantTx, tenantId: string): Promise<PriceList[]> {
    return tx.priceList.findMany({ where: { tenantId }, orderBy: [{ isDefault: 'desc' }, { code: 'asc' }] });
  }

  findById(tx: TenantTx, tenantId: string, id: string): Promise<PriceList | null> {
    return tx.priceList.findFirst({ where: { tenantId, id } });
  }

  /** Sérialise les changements de grille par défaut d'un tenant (index unique partiel `ux_price_lists_default`). */
  async lockDefaultSlot(tx: TenantTx, tenantId: string): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`price_list_default:${tenantId}`}, 0))`;
  }

  async clearDefault(tx: TenantTx, tenantId: string, exceptId?: string): Promise<void> {
    await tx.priceList.updateMany({ where: { tenantId, isDefault: true, ...(exceptId ? { id: { not: exceptId } } : {}) }, data: { isDefault: false } });
  }

  codeExists(tx: TenantTx, tenantId: string, code: string): Promise<boolean> {
    return tx.priceList.count({ where: { tenantId, code } }).then((count) => count > 0);
  }

  create(tx: TenantTx, data: Prisma.PriceListUncheckedCreateInput): Promise<PriceList> {
    return tx.priceList.create({ data });
  }

  update(tx: TenantTx, tenantId: string, id: string, data: Prisma.PriceListUncheckedUpdateInput): Promise<PriceList> {
    return tx.priceList.update({ where: { tenantId_id: { tenantId, id } }, data });
  }

  itemCodeExists(tx: TenantTx, tenantId: string, priceListId: string, code: string): Promise<boolean> {
    return tx.priceListItem.count({ where: { tenantId, priceListId, code } }).then((count) => count > 0);
  }

  createItem(tx: TenantTx, data: Prisma.PriceListItemUncheckedCreateInput): Promise<PriceListItem> {
    return tx.priceListItem.create({ data });
  }

  findItem(tx: TenantTx, tenantId: string, id: string): Promise<PriceListItem | null> {
    return tx.priceListItem.findFirst({ where: { tenantId, id } });
  }

  updateItem(tx: TenantTx, tenantId: string, id: string, data: Prisma.PriceListItemUncheckedUpdateInput): Promise<PriceListItem> {
    return tx.priceListItem.update({ where: { tenantId_id: { tenantId, id } }, data });
  }

  listItems(tx: TenantTx, tenantId: string, c: ItemListCriteria): Promise<PriceListItem[]> {
    return tx.priceListItem.findMany({
      where: {
        tenantId,
        priceListId: c.priceListId,
        ...(c.includeInactive ? {} : { isActive: true }),
        ...(c.category ? { category: c.category } : {}),
        ...(c.q ? { OR: [{ label: { contains: c.q, mode: 'insensitive' } }, { code: { contains: c.q, mode: 'insensitive' } }] } : {}),
        ...(c.afterCode ? { code: { gt: c.afterCode } } : {}),
      },
      orderBy: { code: 'asc' },
      take: c.take,
    });
  }
}
