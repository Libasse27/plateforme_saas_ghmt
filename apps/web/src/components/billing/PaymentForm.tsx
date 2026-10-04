'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import { recordPaymentAction } from '@/actions/payments';
import { Alert } from '@/components/ui/Alert';
import { TextField } from '@/components/ui/Field';
import { FormMessage } from '@/components/ui/FormMessage';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { EMPTY_FORM_STATE } from '@/lib/forms';
import { formatMoney } from '@/lib/domain/money';

type Method = 'cash' | 'mobile_money' | 'other';

const METHODS: readonly { readonly value: Method; readonly label: string }[] = [
  { value: 'cash', label: 'Espèces' },
  { value: 'mobile_money', label: 'Mobile Money' },
  { value: 'other', label: 'Autre mode' },
];

export interface PaymentFormProps {
  readonly invoiceId: string;
  readonly currency: string;
  /** Reste dû (chaîne décimale) : proposé comme montant par défaut. */
  readonly balance: string;
  /** Session de caisse ouverte par l'utilisateur courant, sinon null (espèces impossibles). */
  readonly cashSessionId: string | null;
  /** Droit de lire les sessions de caisse (pour distinguer « pas de session » de « pas d'accès »). */
  readonly canSeeCashier: boolean;
}

export function PaymentForm({ invoiceId, currency, balance, cashSessionId, canSeeCashier }: PaymentFormProps) {
  const [state, formAction] = useActionState(recordPaymentAction, EMPTY_FORM_STATE);
  const [method, setMethod] = useState<Method>(cashSessionId ? 'cash' : 'mobile_money');
  const errors = state.fieldErrors ?? {};
  const cashBlocked = method === 'cash' && !cashSessionId;

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormMessage state={state} />
      {typeof state.extra?.instructions === 'string' ? <Alert tone="info">{state.extra.instructions}</Alert> : null}
      <input type="hidden" name="invoiceId" value={invoiceId} />
      <input type="hidden" name="currency" value={currency} />
      {cashSessionId ? <input type="hidden" name="cashSessionId" value={cashSessionId} /> : null}

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Mode de paiement</legend>
        <div className="flex flex-wrap gap-4">
          {METHODS.map((entry) => (
            <label key={entry.value} className="flex items-center gap-2">
              <input type="radio" name="method" value={entry.value} checked={method === entry.value} onChange={() => { setMethod(entry.value); }} />
              {entry.label}
            </label>
          ))}
        </div>
        {errors.method ? <p className="text-sm font-medium text-red-700">{errors.method}</p> : null}
      </fieldset>

      <TextField
        name="amount"
        label={`Montant (${currency})`}
        required
        inputMode="decimal"
        defaultValue={state.values?.amount ?? balance.replace(/\.00$/, '')}
        hint={`Reste dû : ${formatMoney(balance, currency)}`}
        error={errors.amount}
      />

      {method === 'mobile_money' ? (
        <TextField name="payerPhone" type="tel" label="Téléphone du payeur" required autoComplete="tel" inputMode="tel" hint="Numéro Mobile Money du payeur. Il n'apparaît jamais dans l'adresse de la page." error={errors.payerPhone} />
      ) : null}
      {method === 'other' ? (
        <TextField name="reference" label="Référence du paiement" required hint="N° de chèque, de virement, de bordereau…" defaultValue={state.values?.reference} error={errors.reference} />
      ) : null}

      {cashBlocked ? (
        <Alert tone="warning">
          {canSeeCashier ? (
            <>Vous devez ouvrir une session de caisse avant d&apos;encaisser en espèces. <Link href="/caisse" className="font-semibold underline">Aller à la caisse</Link></>
          ) : (
            <>Aucune session de caisse ouverte pour vous. Demandez l&apos;accès à la caisse pour encaisser en espèces.</>
          )}
        </Alert>
      ) : null}
      {errors.cashSessionId && !cashBlocked ? <p className="text-sm font-medium text-red-700">{errors.cashSessionId}</p> : null}

      {cashBlocked ? null : <SubmitButton pendingLabel="Encaissement…">Encaisser</SubmitButton>}
    </form>
  );
}
