import { Injectable } from '@nestjs/common';
import type { ListPlatformInvoicesQuery, PlatformInvoiceView } from '@ghmt/shared';
import { DomainError } from '../../../common/errors/domain-error';
import { Page, decodeDateIdCursor } from '../../../common/pagination/page';
import { PlatformDb, type PlatformTx } from '../../../infrastructure/prisma/platform-db.service';
import { toSaasInvoiceView, type SaasInvoiceWithLines } from '../../subscriptions/mappers/subscription.mapper';

async function slugsOf(tx: PlatformTx, tenantIds: readonly string[]): Promise<Map<string, string>> {
  const tenants = await tx.tenant.findMany({ where: { id: { in: [...new Set(tenantIds)] } }, select: { id: true, slug: true } });
  return new Map(tenants.map((t) => [t.id, t.slug]));
}

function toView(invoice: SaasInvoiceWithLines, slugs: ReadonlyMap<string, string>): PlatformInvoiceView {
  return { ...toSaasInvoiceView(invoice), tenantId: invoice.tenantId, tenantSlug: slugs.get(invoice.tenantId) ?? '' };
}

/** Factures SaaS vues par la console (lecture seule : les brouillons ne sont jamais exposés). */
@Injectable()
export class PlatformInvoicesService {
  constructor(private readonly platformDb: PlatformDb) {}

  list(query: ListPlatformInvoicesQuery): Promise<Page<PlatformInvoiceView>> {
    const after = decodeDateIdCursor(query.cursor);
    return this.platformDb.run(async (tx) => {
      const rows = await tx.saasInvoice.findMany({
        where: {
          status: query.status ?? { not: 'draft' },
          ...(query.tenantId ? { tenantId: query.tenantId } : {}),
          ...(after ? { OR: [{ issuedAt: { lt: after.date } }, { issuedAt: after.date, id: { lt: after.id } }] } : {}),
        },
        include: { lines: true },
        orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      });
      const slugs = await slugsOf(tx, rows.map((r) => r.tenantId));
      return Page.fromRows(rows, query.limit, (row) => toView(row, slugs), (row) => `${row.issuedAt.toISOString()}|${row.id}`);
    });
  }

  get(id: string): Promise<PlatformInvoiceView> {
    return this.platformDb.run(async (tx) => {
      const invoice = await tx.saasInvoice.findFirst({ where: { id, status: { not: 'draft' } }, include: { lines: true } });
      if (!invoice) throw DomainError.notFound('Facture');
      return toView(invoice, await slugsOf(tx, [invoice.tenantId]));
    });
  }
}
