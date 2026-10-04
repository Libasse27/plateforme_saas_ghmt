'use client';

import { useActionState } from 'react';
import { platformLoginAction } from '@/actions/platform-auth';
import { TextField } from '@/components/ui/Field';
import { FormMessage } from '@/components/ui/FormMessage';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { EMPTY_FORM_STATE } from '@/lib/forms';

export function PlatformLoginForm({ next }: { readonly next: string }) {
  const [state, formAction] = useActionState(platformLoginAction, EMPTY_FORM_STATE);
  const errors = state.fieldErrors ?? {};
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="next" value={next} />
      <TextField name="email" type="email" label="Adresse e-mail" required autoComplete="username" defaultValue={state.values?.email} error={errors.email} />
      <TextField name="password" type="password" label="Mot de passe" required autoComplete="current-password" error={errors.password} />
      <SubmitButton pendingLabel="Connexion…">Se connecter</SubmitButton>
    </form>
  );
}
