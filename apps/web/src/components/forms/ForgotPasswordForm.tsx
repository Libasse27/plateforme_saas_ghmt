'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { forgotPasswordAction } from '@/actions/password-reset';
import { EMPTY_FORM_STATE } from '@/lib/forms';
import { TextField } from '@/components/ui/Field';
import { FormMessage } from '@/components/ui/FormMessage';
import { SubmitButton } from '@/components/ui/SubmitButton';

/** Mot de passe oublié (docs/11 D8) : le message de succès est le même pour tous les comptes. */
export function ForgotPasswordForm({ defaultTenant }: { readonly defaultTenant?: string }) {
  const [state, formAction] = useActionState(forgotPasswordAction, EMPTY_FORM_STATE);
  const errors = state.fieldErrors ?? {};
  const backLink = <Link href="/connexion" className="font-semibold text-blue-800 underline">Retour à la connexion</Link>;

  if (state.ok) {
    return (
      <div className="space-y-4">
        <FormMessage state={state} />
        <p className="text-sm text-slate-800">Le lien reçu par e-mail est valable 30 minutes et ne sert qu&apos;une fois. Pensez à vérifier vos courriers indésirables.</p>
        <p>{backLink}</p>
      </div>
    );
  }

  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <TextField
        name="tenantSlug"
        label="Code établissement"
        required
        autoComplete="organization"
        autoCapitalize="none"
        defaultValue={state.values?.tenantSlug ?? defaultTenant}
        error={errors.tenantSlug}
      />
      <TextField name="email" type="email" label="Adresse e-mail" required autoComplete="username" defaultValue={state.values?.email} error={errors.email} />
      <SubmitButton pendingLabel="Envoi…">Envoyer le lien</SubmitButton>
      <p className="text-sm">{backLink}</p>
    </form>
  );
}
