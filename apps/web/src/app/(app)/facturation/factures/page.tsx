import type { Metadata } from 'next';
import Link from 'next/link';
import { InvoiceList } from '@/components/billing/InvoiceTables';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Alert } from '@/components/ui/Alert';
import { PageHeader } from '@/components/ui/PageHeader';
import { buttonClass, inputClass } from '@/components/ui/styles';
import { settle } from '@/lib/api/settle';
import { canUse } from '@/lib/auth/me';
import { INVOICE_STATUS_LABELS, toInvoiceSummary } from '@/lib/domain/billing';
import { newInvoiceHref } from '@/lib/domain/billing-links';
import { isUuid, items } from '@/lib/domain/raw';
import { pageApi } from '@/server/api';
import { requireMe } from '@/server/me';
import { INVOICE_STATUSES } from '@ghmt/shared';

export const metadata: Metadata = { title: 'Factures' };

const PAGE_SIZE = 25;

interface Search {
  status?: string;
  cursor?: string;
}

function listHref(status: string | undefined, cursor: string | null): string {
  const search = new URLSearchParams();
  if (status) search.set('status', status);
  if (cursor) search.set('cursor', cursor);
  const qs = search.toString();
  return qs ? `/facturation/factures?${qs}` : '/facturation/factures';
}

export default async function InvoicesPage({ searchParams }: { readonly searchParams: Promise<Search> }) {
  const me = await requireMe();
  if (!canUse(me, 'billing', 'billing:invoice:read')) return <AccessDenied what="les factures" />;
  const canCreate = canUse(me, 'billing', 'billing:invoice:create');
  const params = await searchParams;
  const status = (INVOICE_STATUSES as readonly string[]).includes(params.status ?? '') ? params.status : undefined;
  const cursor = isUuid(params.cursor) ? params.cursor : undefined;

  const result = await settle(() => pageApi('/billing/invoices', { query: { status, cursor, limit: PAGE_SIZE } }));
  const pagination = result.ok ? result.value.meta.pagination : undefined;
  const nextCursor = pagination?.hasMore ? pagination.nextCursor : null;

  return (
    <>
      <PageHeader
        title="Factures"
        description="Factures des patients, de l'émission à l'encaissement."
        actions={canCreate ? <Link href={newInvoiceHref({})} className={buttonClass.primary}>Nouvelle facture</Link> : undefined}
      />
      <form method="get" className="mb-6 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="status" className="mb-1 block text-sm font-medium">Statut</label>
          <select id="status" name="status" defaultValue={status ?? ''} className={inputClass}>
            <option value="">Tous</option>
            {Object.entries(INVOICE_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
        <button type="submit" className={buttonClass.primary}>Filtrer</button>
      </form>
      {result.ok ? <InvoiceList invoices={items(result.value.data, toInvoiceSummary)} timeZone={me.tenant.timezone} /> : <Alert tone="error">{result.message}</Alert>}
      {cursor || nextCursor ? (
        <nav aria-label="Pagination" className="mt-4 flex gap-3">
          {cursor ? <Link href={listHref(status, null)} className={buttonClass.secondary}>Retour au début</Link> : null}
          {nextCursor ? <Link href={listHref(status, nextCursor)} className={buttonClass.secondary}>Page suivante</Link> : null}
        </nav>
      ) : null}
    </>
  );
}
