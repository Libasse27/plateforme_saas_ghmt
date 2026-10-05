import type { SaasInvoiceView } from '@ghmt/shared';
import { paySaasInvoiceAction } from '@/actions/subscription';
import { ActionForm } from '@/components/forms/ActionForm';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Cell, DataTable } from '@/components/ui/DataTable';
import { formatDay } from '@/lib/format/dates';
import { formatMoney } from '@/lib/domain/money';
import { canPaySaasInvoice, INVOICE_KIND_LABELS, INVOICE_STATUS_LABELS } from '@/lib/domain/subscription';

const STATUS_TONES: Readonly<Record<SaasInvoiceView['status'], BadgeTone>> = { draft: 'neutral', open: 'warning', paid: 'success', void: 'neutral', uncollectible: 'danger' };

export interface SaasInvoicesTableProps {
  readonly invoices: readonly SaasInvoiceView[];
  readonly canPay: boolean;
  readonly timeZone: string;
}

export function SaasInvoicesTable({ invoices, canPay, timeZone }: SaasInvoicesTableProps) {
  if (invoices.length === 0) return <p className="text-slate-700">Aucune facture pour le moment.</p>;
  return (
    <DataTable
      caption="Factures d'abonnement"
      columns={[{ header: 'Numéro' }, { header: 'Objet' }, { header: 'Échéance' }, { header: 'Total', align: 'right' }, { header: 'Statut' }, { header: 'Paiement' }]}
    >
      {invoices.map((invoice) => (
        <tr key={invoice.id}>
          <Cell className="font-medium">{invoice.number}</Cell>
          <Cell>{INVOICE_KIND_LABELS[invoice.kind]}</Cell>
          <Cell>{formatDay(invoice.dueAt, timeZone)}</Cell>
          <Cell align="right">{formatMoney(invoice.total, invoice.currency)}</Cell>
          <Cell>
            <Badge tone={STATUS_TONES[invoice.status]}>{INVOICE_STATUS_LABELS[invoice.status]}</Badge>
            {invoice.paidAt ? <span className="block text-xs text-slate-700">le {formatDay(invoice.paidAt, timeZone)}</span> : null}
          </Cell>
          <Cell>
            {canPay && canPaySaasInvoice(invoice.status) ? (
              <details>
                <summary className="cursor-pointer font-semibold text-blue-800">Payer par Mobile Money</summary>
                <div className="mt-2 min-w-64">
                  <ActionForm
                    action={paySaasInvoiceAction}
                    idPrefix={`pay-${invoice.id}-`}
                    hidden={{ invoiceId: invoice.id }}
                    fields={[{ kind: 'tel', name: 'payerPhone', label: 'Téléphone du payeur', required: true, autoComplete: 'tel', inputMode: 'tel', hint: 'Le numéro reste confidentiel.' }]}
                    submitLabel={`Payer ${formatMoney(invoice.total, invoice.currency)}`}
                    pendingLabel="Envoi…"
                  />
                </div>
              </details>
            ) : (
              <span className="text-slate-600">-</span>
            )}
          </Cell>
        </tr>
      ))}
    </DataTable>
  );
}
