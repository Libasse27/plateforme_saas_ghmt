'use client';

import { useActionState, useState } from 'react';
import { abandonPaymentAction } from '@/actions/payments';
import { FormMessage } from '@/components/ui/FormMessage';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { buttonClass } from '@/components/ui/styles';
import { EMPTY_FORM_STATE } from '@/lib/forms';

/** Abandon d'un paiement Mobile Money en attente, en deux temps (confirmation explicite) ; affiche l'issue (annulé ou finalement réglé). */
export function AbandonPayment({ paymentId, invoiceId }: { readonly paymentId: string; readonly invoiceId: string }) {
  const [state, formAction] = useActionState(abandonPaymentAction, EMPTY_FORM_STATE);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <div className="space-y-2">
        <FormMessage state={state} />
        <button type="button" className={buttonClass.secondary} onClick={() => { setConfirming(true); }}>
          Abandonner le paiement en ligne
        </button>
      </div>
    );
  }
  return (
    <form action={formAction} className="space-y-2" aria-label="Confirmer l'abandon du paiement en ligne">
      <p className="text-sm text-slate-900">
        Le statut sera d&apos;abord re-vérifié auprès de l&apos;opérateur. Sans paiement confirmé, la demande sera annulée et le montant libéré. Confirmer l&apos;abandon ?
      </p>
      <input type="hidden" name="paymentId" value={paymentId} />
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <div className="flex flex-wrap gap-2">
        <SubmitButton variant="danger" pendingLabel="Vérification…">Confirmer l&apos;abandon</SubmitButton>
        <button type="button" className={buttonClass.secondary} onClick={() => { setConfirming(false); }}>Garder le paiement</button>
      </div>
    </form>
  );
}
