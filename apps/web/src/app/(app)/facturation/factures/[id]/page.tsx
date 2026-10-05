import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { issueInvoiceAction, voidInvoiceAction } from '@/actions/billing-invoices';
import { InvoiceLinesTable, InvoiceStatusBadge, PaymentsTable } from '@/components/billing/InvoiceTables';
import { PaymentForm } from '@/components/billing/PaymentForm';
import { ActionForm } from '@/components/forms/ActionForm';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Alert } from '@/components/ui/Alert';
import { PageHeader } from '@/components/ui/PageHeader';
import { buttonClass } from '@/components/ui/styles';
import { settle } from '@/lib/api/settle';
import { canUse } from '@/lib/auth/me';
import { canIssue, canVoid, isPayable, patientDisplay, toCashSession, toInvoiceDetail, VOID_REASON_LABELS, VOID_REASON_OPTIONS, MAX_VOID_COMMENT, MEDICAL_INFO_WARNING } from '@/lib/domain/billing';
import { formatMoney } from '@/lib/domain/money';
import { isUuid, items } from '@/lib/domain/raw';
import { formatDay } from '@/lib/format/dates';
import { pageApi } from '@/server/api';
import { requireMe } from '@/server/me';

export const metadata: Metadata = { title: 'Facture' };

export default async function InvoiceDetailPage({ params }: { readonly params: Promise<{ id: string }> }) {
  const me = await requireMe();
  if (!canUse(me, 'billing', 'billing:invoice:read')) return <AccessDenied what="les factures" />;
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const result = await settle(() => pageApi(`/billing/invoices/${id}`));
  if (!result.ok) {
    if (result.status === 404) notFound();
    return <Alert tone="error">{result.message}</Alert>;
  }
  const invoice = toInvoiceDetail(result.value.data);
  const tz = me.tenant.timezone;
  const canCollect = canUse(me, 'cashier', 'cashier:payment:create');
  const canSeeCashier = canUse(me, 'cashier', 'cashier:cash_session:read');
  const payable = isPayable(invoice) && canCollect;

  // Session de caisse ouverte par l'utilisateur courant (requise pour les espèces).
  const sessionResult =
    payable && canSeeCashier ? await settle(() => pageApi('/cashier/sessions', { query: { mine: true, status: 'open', limit: 1 } })) : null;
  const openSession = sessionResult?.ok ? items(sessionResult.value.data, toCashSession).find((s) => s.status === 'open') : undefined;

  return (
    <>
      <PageHeader
        title={invoice.number ? `Facture ${invoice.number}` : 'Facture (brouillon)'}
        description={invoice.patient.identityMasked || !invoice.patient.fullName ? patientDisplay(invoice.patient) : `${invoice.patient.fullName}${invoice.patient.ipp ? ` · ${invoice.patient.ipp}` : ''}`}
        actions={
          canUse(me, 'billing', 'billing:invoice:print') && invoice.status !== 'draft' ? (
            <Link href={`/facturation/factures/${encodeURIComponent(invoice.id)}/recu`} className={buttonClass.secondary}>Reçu imprimable</Link>
          ) : undefined
        }
      />
      <div className="space-y-8">
        <dl className="grid gap-3 rounded-md border border-slate-300 bg-white p-4 sm:grid-cols-4">
          <div><dt className="text-sm text-slate-700">Statut</dt><dd><InvoiceStatusBadge status={invoice.status} /></dd></div>
          <div><dt className="text-sm text-slate-700">Total</dt><dd className="font-semibold">{formatMoney(invoice.total, invoice.currency)}</dd></div>
          <div><dt className="text-sm text-slate-700">Encaissé</dt><dd className="font-semibold">{formatMoney(invoice.amountPaid, invoice.currency)}</dd></div>
          <div><dt className="text-sm text-slate-700">Reste dû</dt><dd className="font-semibold">{formatMoney(invoice.balance, invoice.currency)}</dd></div>
        </dl>
        {invoice.status === 'void' ? (
          <Alert tone="error">Facture annulée le {formatDay(invoice.voidedAt, tz)}{invoice.voidReasonCode ? ` : ${VOID_REASON_LABELS[invoice.voidReasonCode]}` : ''}{invoice.voidReason ? ` — ${invoice.voidReason}` : ''}.</Alert>
        ) : null}
        {invoice.notes ? <p className="text-slate-800">Note : {invoice.notes}</p> : null}

        <section aria-labelledby="lignes">
          <h2 id="lignes" className="mb-3 text-lg font-semibold">Lignes</h2>
          <InvoiceLinesTable lines={invoice.lines} currency={invoice.currency} />
        </section>

        {canIssue(invoice) && canUse(me, 'billing', 'billing:invoice:create') ? (
          <section aria-labelledby="emission" className="rounded-md border border-slate-300 bg-white p-4">
            <h2 id="emission" className="mb-2 text-lg font-semibold">Émission</h2>
            <p className="mb-3 text-sm text-slate-800">L&apos;émission attribue le numéro de facture ; une facture émise ne peut plus être modifiée.</p>
            <ActionForm action={issueInvoiceAction} hidden={{ invoiceId: invoice.id }} fields={[]} submitLabel="Émettre la facture" pendingLabel="Émission…" idPrefix="issue-" />
          </section>
        ) : null}

        <section aria-labelledby="paiements">
          <h2 id="paiements" className="mb-3 text-lg font-semibold">Paiements</h2>
          <PaymentsTable payments={invoice.payments} invoiceId={invoice.id} timeZone={tz} canRefresh={canCollect} />
        </section>

        {payable ? (
          <section aria-labelledby="encaissement" className="rounded-md border border-slate-300 bg-white p-4">
            <h2 id="encaissement" className="mb-3 text-lg font-semibold">Encaisser</h2>
            <PaymentForm invoiceId={invoice.id} currency={invoice.currency} balance={invoice.balance} cashSessionId={openSession?.id ?? null} canSeeCashier={canSeeCashier} />
          </section>
        ) : null}

        {canVoid(invoice) && canUse(me, 'billing', 'billing:invoice:validate') ? (
          <section aria-labelledby="annulation">
            <details className="rounded-md border border-slate-300 bg-white p-4">
              <summary id="annulation" className="cursor-pointer font-semibold text-red-800">Annuler la facture</summary>
              <div className="mt-3">
                <p className="mb-3 text-sm text-slate-800">L&apos;annulation est définitive et le numéro n&apos;est jamais réattribué. Elle est impossible si un encaissement existe.</p>
                <ActionForm
                  action={voidInvoiceAction}
                  hidden={{ invoiceId: invoice.id }}
                  fields={[
                    { kind: 'select', name: 'reasonCode', label: 'Motif de l\'annulation', required: true, options: VOID_REASON_OPTIONS, placeholder: 'Choisir un motif…' },
                    { kind: 'textarea', name: 'comment', label: 'Commentaire (facultatif)', maxLength: MAX_VOID_COMMENT, hint: `${MEDICAL_INFO_WARNING} ${String(MAX_VOID_COMMENT)} caractères au plus.` },
                  ]}
                  submitLabel="Confirmer l'annulation"
                  variant="danger"
                  pendingLabel="Annulation…"
                  idPrefix="void-"
                />
              </div>
            </details>
          </section>
        ) : null}
        <p><Link href="/facturation/factures" className="text-blue-800 underline">Retour aux factures</Link></p>
      </div>
    </>
  );
}
