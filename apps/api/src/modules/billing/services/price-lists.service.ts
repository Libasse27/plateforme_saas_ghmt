import { Injectable } from '@nestjs/common';
import type {
  CreatePriceListInput,
  CreatePriceListItemInput,
  ListPriceListItemsInput,
  PriceListItemView,
  PriceListView,
  UpdatePriceListInput,
  UpdatePriceListItemInput,
} from '@ghmt/shared';
import { AuditService } from '../../../common/audit/audit.service';
import { RequestContext } from '../../../common/context/request-context';
import { DomainError } from '../../../common/errors/domain-error';
import { formatMoney, parseMoney } from '../../../common/money/money';
import { Page, decodeCursor } from '../../../common/pagination/page';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { loadTenantProfile } from '../../../infrastructure/tenancy/tenant-profile';
import { toPriceListItemView, toPriceListView } from '../mappers/billing.mapper';
import { PriceListsRepository } from '../repositories/price-lists.repository';
import { isUniqueViolation } from './billing-errors';

const CODE_CURSOR = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function codeTaken(): DomainError {
  return DomainError.conflict('price_list_code_taken', 'Ce code de grille tarifaire est déjà utilisé.');
}

function itemCodeTaken(): DomainError {
  return DomainError.conflict('price_list_item_code_taken', 'Ce code d’article existe déjà dans cette grille.');
}

/** Curseur de liste d'articles : le code (unique par grille) du dernier article servi. */
function decodeCodeCursor(cursor: string | undefined): string | undefined {
  const decoded = decodeCursor(cursor);
  if (decoded === undefined) return undefined;
  if (!CODE_CURSOR.test(decoded)) throw DomainError.validation([{ path: 'cursor', code: 'invalid_cursor', message: 'Curseur invalide.' }]);
  return decoded;
}

/** Différences champ par champ (ancienne et nouvelle valeur) pour l'audit ; aucune donnée clinique. */
function diff(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of Object.keys(after)) {
    if (before[key] !== after[key]) changes[key] = { from: before[key], to: after[key] };
  }
  return changes;
}

@Injectable()
export class PriceListsService {
  constructor(
    private readonly db: TenantDb,
    private readonly repo: PriceListsRepository,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
  ) {}

  list(): Promise<PriceListView[]> {
    const { tenantId } = this.context.requirePrincipal();
    return this.db.run(async (tx) => (await this.repo.list(tx, tenantId)).map(toPriceListView));
  }

  async create(input: CreatePriceListInput): Promise<PriceListView> {
    const { tenantId, userId } = this.context.requirePrincipal();
    try {
      return await this.db.run(async (tx) => {
        const profile = await loadTenantProfile(tx);
        if (input.isDefault) await this.repo.lockDefaultSlot(tx, tenantId);
        if (await this.repo.codeExists(tx, tenantId, input.code)) throw codeTaken();
        if (input.isDefault) await this.repo.clearDefault(tx, tenantId);
        const row = await this.repo.create(tx, {
          tenantId,
          code: input.code,
          name: input.name,
          currency: input.currency ?? profile.baseCurrency,
          isDefault: input.isDefault,
          createdBy: userId,
          updatedBy: userId,
        });
        await this.audit.record(tx, tenantId, {
          action: 'price_list.created',
          resourceType: 'price_list',
          resourceId: row.id,
          changes: { code: row.code, currency: row.currency, isDefault: row.isDefault },
        });
        return toPriceListView(row);
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) throw codeTaken();
      throw error;
    }
  }

  update(id: string, input: UpdatePriceListInput): Promise<PriceListView> {
    const { tenantId, userId } = this.context.requirePrincipal();
    return this.db.run(async (tx) => {
      if (input.isDefault) await this.repo.lockDefaultSlot(tx, tenantId);
      const current = await this.requireList(tx, tenantId, id);
      if (input.isDefault) await this.repo.clearDefault(tx, tenantId, id);
      const row = await this.repo.update(tx, tenantId, id, { ...input, updatedBy: userId });
      await this.audit.record(tx, tenantId, {
        action: 'price_list.updated',
        resourceType: 'price_list',
        resourceId: id,
        changes: diff({ name: current.name, isDefault: current.isDefault, isActive: current.isActive }, { ...input }),
      });
      return toPriceListView(row);
    });
  }

  listItems(listId: string, input: ListPriceListItemsInput): Promise<Page<PriceListItemView>> {
    const { tenantId } = this.context.requirePrincipal();
    const afterCode = decodeCodeCursor(input.cursor);
    return this.db.run(async (tx) => {
      await this.requireList(tx, tenantId, listId);
      const rows = await this.repo.listItems(tx, tenantId, {
        priceListId: listId,
        category: input.category,
        q: input.q,
        includeInactive: input.includeInactive,
        afterCode,
        take: input.limit + 1,
      });
      return Page.fromRows(rows, input.limit, toPriceListItemView, (row) => row.code);
    });
  }

  async createItem(listId: string, input: CreatePriceListItemInput): Promise<PriceListItemView> {
    const { tenantId } = this.context.requirePrincipal();
    try {
      return await this.db.run(async (tx) => {
        await this.requireList(tx, tenantId, listId);
        if (await this.repo.itemCodeExists(tx, tenantId, listId, input.code)) throw itemCodeTaken();
        const row = await this.repo.createItem(tx, {
          tenantId,
          priceListId: listId,
          code: input.code,
          label: input.label,
          category: input.category,
          unitPrice: parseMoney(input.unitPrice),
          isActive: input.isActive,
        });
        await this.audit.record(tx, tenantId, {
          action: 'price_list_item.created',
          resourceType: 'price_list_item',
          resourceId: row.id,
          changes: { priceListId: listId, code: row.code, category: row.category, unitPrice: formatMoney(row.unitPrice) },
        });
        return toPriceListItemView(row);
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) throw itemCodeTaken();
      throw error;
    }
  }

  updateItem(id: string, input: UpdatePriceListItemInput): Promise<PriceListItemView> {
    const { tenantId } = this.context.requirePrincipal();
    return this.db.run(async (tx) => {
      const current = await this.repo.findItem(tx, tenantId, id);
      if (!current) throw DomainError.notFound('Article');
      const data = { ...input, ...(input.unitPrice !== undefined ? { unitPrice: parseMoney(input.unitPrice) } : {}) };
      const row = await this.repo.updateItem(tx, tenantId, id, data);
      await this.audit.record(tx, tenantId, {
        action: 'price_list_item.updated',
        resourceType: 'price_list_item',
        resourceId: id,
        changes: diff(
          { label: current.label, category: current.category, unitPrice: formatMoney(current.unitPrice), isActive: current.isActive },
          { ...input, ...(input.unitPrice !== undefined ? { unitPrice: formatMoney(row.unitPrice) } : {}) },
        ),
      });
      return toPriceListItemView(row);
    });
  }

  private async requireList(tx: TenantTx, tenantId: string, id: string) {
    const list = await this.repo.findById(tx, tenantId, id);
    if (!list) throw DomainError.notFound('Grille tarifaire');
    return list;
  }
}
