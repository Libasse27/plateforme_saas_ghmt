import { MANUAL_PAYMENT_METHODS } from '@ghmt/shared';
import { recordManualPaymentAction, rejectManualPaymentAction, validateManualPaymentAction } from '@/actions/platform-console';
import { ActionForm } from '@/components/forms/ActionForm';
import { MANUAL_METHOD_LABELS } from '@/lib/domain/platform';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Saisie d'un paiement manuel (montant exact de la facture) : sera validé par un autre administrateur. */
export function RecordManualPaymentForm({ invoiceId, total }: { readonly invoiceId: string; readonly total: string }) {
  return (
    <ActionForm
      action={recordManualPaymentAction}
      hidden={{ invoiceId }}
      idPrefix={`manuel-${invoiceId}-`}
      submitLabel="Saisir le paiement"
      pendingLabel="Enregistrement…"
      fields={[
        { kind: 'text', name: 'amount', label: 'Montant reçu', required: true, inputMode: 'decimal', defaultValue: total.replace(/\.00$/, ''), hint: 'Doit être exactement le montant de la facture.' },
        { kind: 'select', name: 'method', label: 'Mode', required: true, options: MANUAL_PAYMENT_METHODS.map((value) => ({ value, label: MANUAL_METHOD_LABELS[value] ?? value })) },
        { kind: 'text', name: 'reference', label: 'Référence', required: true },
        { kind: 'date', name: 'receivedAt', label: 'Date de réception', required: true, defaultValue: todayIso() },
      ]}
    />
  );
}

/** Décision d'un second administrateur (quatre yeux) sur un paiement en attente. */
export function DecideManualPayment({ paymentId }: { readonly paymentId: string }) {
  return (
    <div className="space-y-3">
      <ActionForm action={validateManualPaymentAction} hidden={{ paymentId }} fields={[]} idPrefix={`valider-${paymentId}-`} submitLabel="Valider le paiement" pendingLabel="Validation…" />
      <details>
        <summary className="cursor-pointer font-semibold text-red-800">Rejeter</summary>
        <div className="mt-2 min-w-64">
          <ActionForm
            action={rejectManualPaymentAction}
            hidden={{ paymentId }}
            idPrefix={`rejeter-${paymentId}-`}
            variant="danger"
            submitLabel="Rejeter le paiement"
            pendingLabel="Rejet…"
            fields={[{ kind: 'textarea', name: 'reason', label: 'Motif du rejet', required: true, hint: '5 à 500 caractères.' }]}
          />
        </div>
      </details>
    </div>
  );
}
