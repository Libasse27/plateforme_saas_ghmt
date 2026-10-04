import type { Metadata } from 'next';
import Link from 'next/link';
import { SAAS_INVOICE_STATUSES } from '@ghmt/shared';
import { DecideManualPayment, RecordManualPaymentForm } from '@/components/platform/ManualPaymentForms';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Alert } from '@/components/ui/Alert';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Cell, DataTable } from '@/components/ui/DataTable';
import { PageHeader } from '@/components/ui/PageHeader';
import { buttonClass, inputClass } from '@/components/ui/styles';
import { settle } from '@/lib/api/settle';
import { hasPlatformPermission } from '@/lib/auth/platform-me';
import { MANUAL_METHOD_LABELS, toManualPayment, toPlatformInvoice } from '@/lib/domain/platform';
import { formatMoney } from '@/lib/domain/money';
import { isUuid, items } from '@/lib/domain/raw';
import { canPaySaasInvoice, INVOICE_KIND_LABELS, INVOICE_STATUS_LABELS } from '@/lib/domain/subscription';
import { formatDay } from '@/lib/format/dates';
import { platformPageApi } from '@/server/platform-api';
import { requirePlatformMe } from '@/server/platform-me';

export const metadata: Metadata = { title: 'Factures SaaS' };

const PAGE_SIZE = 20;
const TONES: Readonly<Record<string, BadgeTone>> = { draft: 'neutral', open: 'warning', paid: 'success', void: 'neutral', uncollectible: 'danger' };

interface Search {
  status?: string;
  tenantId?: string;
  cursor?: string;
}

function pageHref(filters: Readonly<Record<string, string | undefined>>, cursor: string | null): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) search.set(key, value);
  if (cursor) search.set('cursor', cursor);
  const qs = search.toString();
  return qs ? `/plateforme/factures?${qs}` : '/plateforme/factures';
}

export default async function PlatformInvoicesPage({ searchParams }: { readonly searchParams: Promise<Search> }) {
  const me = await requirePlatformMe();
  if (!hasPlatformPermission(me, 'invoices:read')) return <AccessDenied what="les factures SaaS" />;
  const canWrite = hasPlatformPermission(me, 'invoices:write');
  const canValidate = hasPlatformPermission(me, 'invoices:validate');
  const params = await searchParams;
  const filters = {
    status: SAAS_INVOICE_STATUSES.find((status) => status === params.status),
    tenantId: isUuid(params.tenantId) ? params.tenantId : undefined,
  };
  const cursor = isUuid(params.cursor) ? params.cursor : undefined;

  const [invoicesResult, pendingResult] = await Promise.all([
    settle(() => platformPageApi('/platform/invoices', { query: { ...filters, cursor, limit: PAGE_SIZE } })),
    settle(() => platformPageApi('/platform/invoices/manual-payments', { query: { status: 'pending', limit: PAGE_SIZE } })),
  ]);
  const invoices = invoicesResult.ok ? items(invoicesResult.value.data, toPlatformInvoice) : [];
  const pending = pendingResult.ok ? items(pendingResult.value.data, toManualPayment) : [];
  const pagination = invoicesResult.ok ? invoicesResult.value.meta.pagination : undefined;
  const nextCursor = pagination?.hasMore ? pagination.nextCursor : null;

  return (
    <>
      <PageHeader title="Factures SaaS" description="Paiements manuels : la validation doit être faite par un autre administrateur que celui qui a saisi le paiement." />
      <div className="space-y-8">
        <section aria-labelledby="titre-attente">
          <h2 id="titre-attente" className="mb-3 text-lg font-semibold">Paiements manuels en attente de validation</h2>
          {!pendingResult.ok ? <Alert tone="error">{pendingResult.message}</Alert> : null}
          {pendingResult.ok && pending.length === 0 ? <p className="text-slate-700">Aucun paiement en attente.</p> : null}
          {pending.length > 0 ? (
            <DataTable
              caption="Paiements manuels en attente"
              columns={[{ header: 'Facture' }, { header: 'Mode' }, { header: 'Référence' }, { header: 'Reçu le' }, { header: 'Montant', align: 'right' }, ...(canValidate ? [{ header: 'Décision' }] : [])]}
            >
              {pending.map((payment) => (
                <tr key={payment.id}>
                  <Cell className="font-medium">{payment.invoiceNumber}</Cell>
                  <Cell>{MANUAL_METHOD_LABELS[payment.method] ?? payment.method}</Cell>
                  <Cell>{payment.reference}</Cell>
                  <Cell>{formatDay(payment.receivedAt, 'UTC')}</Cell>
                  <Cell align="right">{formatMoney(payment.amount, payment.currency)}</Cell>
                  {canValidate ? <Cell><DecideManualPayment paymentId={payment.id} /></Cell> : null}
                </tr>
              ))}
            </DataTable>
          ) : null}
        </section>

        <section aria-labelledby="titre-factures">
          <h2 id="titre-factures" className="mb-3 text-lg font-semibold">Factures</h2>
          <form method="get" className="mb-4 flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="status" className="mb-1 block text-sm font-medium">Statut</label>
              <select id="status" name="status" defaultValue={filters.status ?? ''} className={inputClass}>
                <option value="">Tous</option>
                {SAAS_INVOICE_STATUSES.map((status) => <option key={status} value={status}>{INVOICE_STATUS_LABELS[status]}</option>)}
              </select>
            </div>
            {filters.tenantId ? <input type="hidden" name="tenantId" value={filters.tenantId} /> : null}
            <button type="submit" className={buttonClass.primary}>Filtrer</button>
          </form>
          {!invoicesResult.ok ? <Alert tone="error">{invoicesResult.message}</Alert> : null}
          {invoicesResult.ok && invoices.length === 0 ? <p className="text-slate-700">Aucune facture ne correspond à ces critères.</p> : null}
          {invoices.length > 0 ? (
            <DataTable
              caption="Factures SaaS"
              columns={[{ header: 'Numéro' }, { header: 'Établissement' }, { header: 'Objet' }, { header: 'Échéance' }, { header: 'Total', align: 'right' }, { header: 'Statut' }, ...(canWrite ? [{ header: 'Paiement manuel' }] : [])]}
            >
              {invoices.map((invoice) => (
                <tr key={invoice.id}>
                  <Cell className="font-medium">{invoice.number}</Cell>
                  <Cell><Link href={`/plateforme/etablissements/${encodeURIComponent(invoice.tenantId)}`} className="text-blue-800 underline">{invoice.tenantSlug}</Link></Cell>
                  <Cell>{INVOICE_KIND_LABELS[invoice.kind]}</Cell>
                  <Cell>{formatDay(invoice.dueAt, 'UTC')}</Cell>
                  <Cell align="right">{formatMoney(invoice.total, invoice.currency)}</Cell>
                  <Cell><Badge tone={TONES[invoice.status] ?? 'neutral'}>{INVOICE_STATUS_LABELS[invoice.status]}</Badge></Cell>
                  {canWrite ? (
                    <Cell>
                      {canPaySaasInvoice(invoice.status) ? (
                        <details>
                          <summary className="cursor-pointer font-semibold text-blue-800">Saisir un paiement</summary>
                          <div className="mt-2 min-w-64"><RecordManualPaymentForm invoiceId={invoice.id} total={invoice.total} /></div>
                        </details>
                      ) : <span className="text-slate-600">-</span>}
                    </Cell>
                  ) : null}
                </tr>
              ))}
            </DataTable>
          ) : null}
          {cursor || nextCursor ? (
            <nav aria-label="Pagination" className="mt-4 flex gap-3">
              {cursor ? <Link href={pageHref(filters, null)} className={buttonClass.secondary}>Retour au début</Link> : null}
              {nextCursor ? <Link href={pageHref(filters, nextCursor)} className={buttonClass.secondary}>Page suivante</Link> : null}
            </nav>
          ) : null}
        </section>
      </div>
    </>
  );
}
