'use client';

import { useActionState } from 'react';
import { mfaVerifyAction } from '@/actions/auth';
import { EMPTY_FORM_STATE } from '@/lib/forms';
import { FormMessage } from '@/components/ui/FormMessage';
import { TextField } from '@/components/ui/Field';
import { SubmitButton } from '@/components/ui/SubmitButton';

export function MfaVerifyForm({ next }: { readonly next: string }) {
  const [state, formAction] = useActionState(mfaVerifyAction, EMPTY_FORM_STATE);
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="next" value={next} />
      <TextField
        name="code"
        label="Code de vérification"
        hint="Code à 6 chiffres de votre application d'authentification, ou code de secours."
        required
        autoComplete="one-time-code"
        inputMode="numeric"
        autoFocus
        error={state.fieldErrors?.code}
      />
      <SubmitButton pendingLabel="Vérification…">Valider</SubmitButton>
    </form>
  );
}
