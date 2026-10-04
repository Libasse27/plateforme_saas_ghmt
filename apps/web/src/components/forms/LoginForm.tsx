'use client';

import { useActionState } from 'react';
import { loginAction } from '@/actions/auth';
import { EMPTY_FORM_STATE } from '@/lib/forms';
import { FormMessage } from '@/components/ui/FormMessage';
import { TextField } from '@/components/ui/Field';
import { SubmitButton } from '@/components/ui/SubmitButton';

export function LoginForm({ next, defaultTenant }: { readonly next: string; readonly defaultTenant?: string }) {
  const [state, formAction] = useActionState(loginAction, EMPTY_FORM_STATE);
  const errors = state.fieldErrors ?? {};
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="next" value={next} />
      <TextField
        name="tenantSlug"
        label="Code établissement"
        hint="Fourni lors de l'inscription, par exemple clinique-sante."
        required
        autoComplete="organization"
        autoCapitalize="none"
        defaultValue={state.values?.tenantSlug ?? defaultTenant}
        error={errors.tenantSlug}
      />
      <TextField name="email" type="email" label="Adresse e-mail" required autoComplete="username" defaultValue={state.values?.email} error={errors.email} />
      <TextField name="password" type="password" label="Mot de passe" required autoComplete="current-password" error={errors.password} />
      <SubmitButton pendingLabel="Connexion…">Se connecter</SubmitButton>
    </form>
  );
}
