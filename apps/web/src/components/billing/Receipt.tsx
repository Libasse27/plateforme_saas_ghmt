import { CATEGORY_LABELS, INVOICE_STATUS_LABELS, PAYMENT_METHOD_LABELS, patientDisplay, receiptLabel, type ReceiptData } from '@/lib/domain/billing';
import { formatMoney } from '@/lib/domain/money';
import { formatDateTime, formatDay } from '@/lib/format/dates';

/** Reçu imprimable (A5/A4) : mise en page sobre, contraste élevé, sans élément interactif. */
export function Receipt({ receipt, timeZone }: { readonly receipt: ReceiptData; readonly timeZone: string }) {
  const { invoice } = receipt;
  const currency = invoice.currency;
  const voided = receipt.voided || invoice.status === 'void';
  const succeeded = invoice.payments.filter((payment) => payment.status === 'succeeded');
  return (
    <article className="receipt mx-auto max-w-2xl rounded-md border border-slate-400 bg-white p-6 text-slate-900 print:max-w-none print:border-0 print:p-0 relative overflow-hidden" aria-label={`Reçu ${invoice.number ?? ''}`}>
      {voided ? (
        <div
          aria-hidden="true"
          data-testid="receipt-watermark"
          className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center"
        >
          <span className="-rotate-[30deg] select-none rounded-md border-8 border-red-700 px-6 py-2 text-7xl font-black uppercase tracking-widest text-red-700 opacity-40 print:opacity-50">
            ANNULÉE
          </span>
        </div>
      ) : null}
      <header className="mb-4 border-b border-slate-400 pb-3">
        <h1 className="text-xl font-bold">{receipt.establishment}</h1>
        {receipt.site ? <p>{receipt.site}</p> : null}
        <p className="mt-2 text-lg font-semibold">Reçu de facture {invoice.number ?? '(brouillon)'}</p>
        <p className="text-sm">Émise le {formatDay(invoice.issuedAt ?? invoice.createdAt, timeZone)} · {INVOICE_STATUS_LABELS[invoice.status]}</p>
      </header>

      <p className="mb-4">
        <strong>{patientDisplay(invoice.patient)}</strong>
        {invoice.patient.ipp && !invoice.patient.identityMasked ? <> · Dossier {invoice.patient.ipp}</> : null}
      </p>

      <table className="mb-4 w-full text-left text-sm">
        <caption className="sr-only">Détail de la facture</caption>
        <thead>
          <tr className="border-b border-slate-400">
            <th scope="col" className="py-1">Désignation</th>
            <th scope="col" className="py-1 text-right">Qté</th>
            <th scope="col" className="py-1 text-right">Prix unitaire</th>
            <th scope="col" className="py-1 text-right">Total</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((line) => (
            <tr key={line.id || line.lineNo} className="border-b border-slate-200">
              <td className="py-1">{receiptLabel(line)} <span className="text-xs">({CATEGORY_LABELS[line.category]})</span></td>
              <td className="py-1 text-right tabular-nums">{line.quantity}</td>
              <td className="py-1 text-right tabular-nums">{formatMoney(line.unitPrice, currency)}</td>
              <td className="py-1 text-right tabular-nums">{formatMoney(line.lineTotal, currency)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="ml-auto mb-4 max-w-xs space-y-1">
        <div className="flex justify-between"><dt>Total</dt><dd className="font-semibold tabular-nums">{formatMoney(invoice.total, currency)}</dd></div>
        <div className="flex justify-between"><dt>Encaissé</dt><dd className="tabular-nums">{formatMoney(invoice.amountPaid, currency)}</dd></div>
        <div className="flex justify-between border-t border-slate-400 pt-1"><dt>Reste dû</dt><dd className="font-semibold tabular-nums">{formatMoney(invoice.balance, currency)}</dd></div>
      </dl>

      {succeeded.length > 0 ? (
        <section aria-label="Paiements reçus" className="mb-4 text-sm">
          <h2 className="font-semibold">Paiements reçus</h2>
          <ul>
            {succeeded.map((payment) => (
              <li key={payment.id}>
                {formatDateTime(payment.paidAt ?? payment.createdAt, timeZone)} · {PAYMENT_METHOD_LABELS[payment.method]} · {formatMoney(payment.amount, payment.currency)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <footer className="border-t border-slate-400 pt-2 text-xs">Imprimé le {formatDateTime(receipt.printedAt, timeZone)}</footer>
    </article>
  );
}
