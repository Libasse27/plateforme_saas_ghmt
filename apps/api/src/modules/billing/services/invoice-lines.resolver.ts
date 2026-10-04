import { Injectable } from '@nestjs/common';
import type { InvoiceLineInput, PermissionKey } from '@ghmt/shared';
import { RequestContext } from '../../../common/context/request-context';
import { DomainError, type FieldIssue } from '../../../common/errors/domain-error';
import { parseMoney } from '../../../common/money/money';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { computeLine } from '../domain/invoice-calculation';
import { holdsPermission } from '../domain/billing-scope';
import { InvoicesRepository, type NewLine } from '../repositories/invoices.repository';

const FREE_LINE_PERMISSION: PermissionKey = 'billing:invoice:update';

function catalogIdOf(line: InvoiceLineInput): string | null {
  return 'priceListItemId' in line ? line.priceListItemId : null;
}

/**
 * Transforme les lignes demandées en lignes de facture : prix figés depuis la grille (jamais depuis le client),
 * ligne libre réservée à `billing:invoice:update`, totaux calculés côté serveur.
 */
@Injectable()
export class InvoiceLinesResolver {
  constructor(
    private readonly invoices: InvoicesRepository,
    private readonly context: RequestContext,
  ) {}

  async resolve(tx: TenantTx, tenantId: string, currency: string, inputs: readonly InvoiceLineInput[]): Promise<NewLine[]> {
    if (inputs.some((line) => catalogIdOf(line) === null) && !holdsPermission(FREE_LINE_PERMISSION, this.context.grants)) {
      throw DomainError.forbidden('free_line_forbidden', 'Les lignes libres exigent la permission de modifier les factures.', FREE_LINE_PERMISSION);
    }
    const ids = [...new Set(inputs.flatMap((line) => catalogIdOf(line) ?? []))];
    const catalog = new Map((await this.invoices.findCatalogItems(tx, tenantId, ids)).map((item) => [item.id, item]));
    const issues: FieldIssue[] = [];
    const lines = inputs.map((input, index): NewLine | null => {
      const itemId = catalogIdOf(input);
      if (itemId === null) {
        const free = input as Extract<InvoiceLineInput, { description: string }>;
        return { priceListItemId: null, category: free.category, description: free.description, ...computeLine(free.quantity, parseMoney(free.unitPrice)) };
      }
      const item = catalog.get(itemId);
      const path = `lines.${index}.priceListItemId`;
      if (!item) {
        issues.push({ path, code: 'not_found', message: 'Article introuvable.' });
        return null;
      }
      if (!item.isActive || !item.priceList.isActive) {
        issues.push({ path, code: 'inactive', message: 'Article ou grille tarifaire inactif.' });
        return null;
      }
      if (item.priceList.currency !== currency) {
        issues.push({ path, code: 'currency_mismatch', message: `La grille de cet article n’est pas en ${currency}.` });
        return null;
      }
      const quantity = (input as { quantity: string }).quantity;
      return { priceListItemId: item.id, category: item.category, description: item.label, ...computeLine(quantity, item.unitPrice) };
    });
    if (issues.length > 0) throw DomainError.validation(issues);
    return lines.filter((line): line is NewLine => line !== null);
  }
}
