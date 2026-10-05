'use client';

import { useActionState, useState } from 'react';
import { closeSessionAction } from '@/actions/cashier';
import { TextField } from '@/components/ui/Field';
import { FormMessage } from '@/components/ui/FormMessage';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { EMPTY_FORM_STATE } from '@/lib/forms';
import { formatMoney, isZeroDecimalCurrency, parseMoneyInput, subtractAmounts } from '@/lib/domain/money';

export const VARIANCE_NOTE_MESSAGE = 'L\'écart est non nul : expliquez-le dans la note (obligatoire).';

export interface CloseSessionFormProps {
  readonly sessionId: string;
  readonly currency: string;
  readonly expectedTotal: string;
}

/** Clôture par l'ouvreur : l'écart est calculé et affiché avant l'envoi ; une note est exigée dès que l'écart n'est pas nul. */
export function CloseSessionForm({ sessionId, currency, expectedTotal }: CloseSessionFormProps) {
  const [state, formAction] = useActionState(closeSessionAction, EMPTY_FORM_STATE);
  const [counted, setCounted] = useState('');
  const [note, setNote] = useState('');
  const [blocked, setBlocked] = useState(false);
  const parsed = counted.trim() === '' ? null : parseMoneyInput(counted, currency);
  const variance = parsed?.ok ? subtractAmounts(parsed.amount, expectedTotal) : null;
  const hasVariance = variance !== null && /[1-9]/.test(variance);
  const noteMissing = hasVariance && note.trim() === '';
  const errors = state.fieldErrors ?? {};

  return (
    <form
      action={formAction}
      noValidate
      className="space-y-3"
      onSubmit={(event) => {
        if (noteMissing) {
          event.preventDefault();
          setBlocked(true);
        }
      }}
    >
      <FormMessage state={state} />
      <input type="hidden" name="sessionId" value={sessionId} />
      <input type="hidden" name="currency" value={currency} />
      <input type="hidden" name="expectedTotal" value={expectedTotal} />
      <TextField
        id="close-countedAmount"
        name="countedAmount"
        label={`Montant compté (${currency})`}
        required
        inputMode={isZeroDecimalCurrency(currency) ? 'numeric' : 'decimal'}
        value={counted}
        onChange={(event) => { setCounted(event.target.value); setBlocked(false); }}
        error={errors.countedAmount ?? (parsed && !parsed.ok ? parsed.error : undefined)}
      />
      {variance !== null ? (
        <p aria-live="polite" className={hasVariance ? 'font-semibold text-red-800' : 'text-slate-800'}>
          Attendu : {formatMoney(expectedTotal, currency)} · écart : {formatMoney(variance, currency)}
        </p>
      ) : null}
      <TextField
        id="close-note"
        name="note"
        label={hasVariance ? 'Note (obligatoire : écart non nul)' : 'Note (facultative)'}
        required={hasVariance}
        value={note}
        onChange={(event) => { setNote(event.target.value); setBlocked(false); }}
        error={errors.note ?? (blocked && noteMissing ? VARIANCE_NOTE_MESSAGE : undefined)}
      />
      <SubmitButton pendingLabel="Clôture…">Clôturer la session</SubmitButton>
    </form>
  );
}
