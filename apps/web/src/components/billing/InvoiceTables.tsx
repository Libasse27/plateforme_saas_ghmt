import type { InvoiceSummaryView } from '@ghmt/shared';
import Link from 'next/link';
import { refreshPaymentAction } from '@/actions/payments';
import { AbandonPayment } from '@/components/billing/AbandonPayment';
import { ActionForm } from '@/components/forms/ActionForm';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Cell, DataTable } from '@/components/ui/DataTable';
import { CATEGORY_LABELS, INVOICE_STATUS_LABELS, PAYMENT_METHOD_LABELS, PAYMENT_STATUS_LABELS, displayLabel, type InvoiceLine, type PaymentStatus, type PaymentView } from '@/lib/domain/billing';
import { formatMoney } from '@/lib/domain/money';
import { formatDateTime, formatDay } from '@/lib/format/dates';

const INVOICE_TONES: Readonly<Record<InvoiceSummaryView['status'], BadgeTone>> = {
  draft: 'neutral',
  issued: 'info',
  partially_paid: 'warning',
  paid: 'success',
  void: 'danger',
};

const PAYMENT_TONES: Readonly<Record<PaymentStatus, BadgeTone>> = { pending: 'warning', succeeded: 'success', failed: 'danger', cancelled: 'neutral' };

export function InvoiceStatusBadge({ status }: { readonly status: InvoiceSummaryView['status'] }) {
  return <Badge tone={INVOICE_TONES[status]}>{INVOICE_STATUS_LABELS[status]}</Badge>;
}

export function InvoiceList({ invoices, timeZone }: { readonly invoices: readonly InvoiceSummaryView[]; readonly timeZone: string }) {
  if (invoices.length === 0) return <p className="text-slate-700">Aucune facture ne correspond à ces critères.</p>;
  return (
    <DataTable
      caption="Factures"
      columns={[{ header: 'Numéro' }, { header: 'Date' }, { header: 'Statut' }, { header: 'Total', align: 'right' }, { header: 'Encaissé', align: 'right' }, { header: 'Reste dû', align: 'right' }]}
    >
      {invoices.map((invoice) => (
        <tr key={invoice.id}>
          <Cell>
            <Link href={`/facturation/factures/${encodeURIComponent(invoice.id)}`} className="font-semibold text-blue-800 underline">{invoice.number ?? 'Brouillon'}</Link>
          </Cell>
          <Cell>{formatDay(invoice.issuedAt ?? invoice.createdAt, timeZone)}</Cell>
          <Cell><InvoiceStatusBadge status={invoice.status} /></Cell>
          <Cell align="right">{formatMoney(invoice.total, invoice.currency)}</Cell>
          <Cell align="right">{formatMoney(invoice.amountPaid, invoice.currency)}</Cell>
          <Cell align="right">{formatMoney(invoice.balance, invoice.currency)}</Cell>
        </tr>
      ))}
    </DataTable>
  );
}

export function InvoiceLinesTable({ lines, currency }: { readonly lines: readonly InvoiceLine[]; readonly currency: string }) {
  return (
    <DataTable
      caption="Lignes de la facture"
      columns={[{ header: 'Désignation' }, { header: 'Catégorie' }, { header: 'Qté', align: 'right' }, { header: 'Prix unitaire', align: 'right' }, { header: 'Total', align: 'right' }]}
    >
      {lines.map((line) => (
        <tr key={line.id || line.lineNo}>
          <Cell>{displayLabel(line)}</Cell>
          <Cell>{CATEGORY_LABELS[line.category]}</Cell>
          <Cell align="right">{line.quantity}</Cell>
          <Cell align="right">{formatMoney(line.unitPrice, currency)}</Cell>
          <Cell align="right">{formatMoney(line.lineTotal, currency)}</Cell>
        </tr>
      ))}
    </DataTable>
  );
}

export interface PaymentsTableProps {
  readonly payments: readonly PaymentView[];
  readonly invoiceId: string;
  readonly timeZone: string;
  readonly canRefresh: boolean;
}

export function PaymentsTable({ payments, invoiceId, timeZone, canRefresh }: PaymentsTableProps) {
  if (payments.length === 0) return <p className="text-slate-700">Aucun paiement enregistré.</p>;
  return (
    <DataTable
      caption="Paiements de la facture"
      columns={[{ header: 'Date' }, { header: 'Mode' }, { header: 'Montant', align: 'right' }, { header: 'Statut' }, { header: 'Détail' }]}
    >
      {payments.map((payment) => {
        const online = payment.method === 'mobile_money' || payment.method === 'card';
        return (
          <tr key={payment.id}>
            <Cell>{formatDateTime(payment.paidAt ?? payment.createdAt, timeZone)}</Cell>
            <Cell>{PAYMENT_METHOD_LABELS[payment.method]}</Cell>
            <Cell align="right">{formatMoney(payment.amount, payment.currency)}</Cell>
            <Cell><Badge tone={PAYMENT_TONES[payment.status]}>{PAYMENT_STATUS_LABELS[payment.status]}</Badge></Cell>
            <Cell>
              {payment.reference ? <span className="block text-sm">Réf. {payment.reference}</span> : null}
              {payment.anomaly === 'overpaid' ? <span className="block text-sm font-semibold text-amber-900">Anomalie : paiement supérieur au reste dû (trop-perçu)</span> : null}
              {payment.failureReason ? <span className="block text-sm text-red-800">{payment.failureReason}</span> : null}
              {payment.status === 'pending' && online ? (
                <div className="space-y-2">
                  {payment.checkoutUrl && /^https?:\/\//i.test(payment.checkoutUrl) ? (
                    <a href={payment.checkoutUrl} rel="noopener noreferrer" className="block text-sm font-semibold text-blue-800 underline">Reprendre le paiement</a>
                  ) : null}
                  {canRefresh && payment.method === 'mobile_money' ? <AbandonPayment paymentId={payment.id} invoiceId={invoiceId} /> : null}
                  {canRefresh ? (
                    <ActionForm
                      action={refreshPaymentAction}
                      idPrefix={`refresh-${payment.id}-`}
                      hidden={{ paymentId: payment.id, invoiceId }}
                      fields={[]}
                      submitLabel="Actualiser"
                      pendingLabel="Vérification…"
                      variant="secondary"
                    />
                  ) : null}
                </div>
              ) : null}
            </Cell>
          </tr>
        );
      })}
    </DataTable>
  );
}
