'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { resendSignupVerificationAction, verifySignupAction } from '@/actions/signup-verification';
import { EMPTY_FORM_STATE } from '@/lib/forms';
import { TextField } from '@/components/ui/Field';
import { FormMessage } from '@/components/ui/FormMessage';
import { SubmitButton } from '@/components/ui/SubmitButton';

/** Renvoi de l'e-mail de confirmation (docs/11 §6.2) : même message pour tous les comptes. */
export function ResendVerificationForm({ defaultTenant }: { readonly defaultTenant?: string }) {
  const [state, formAction] = useActionState(resendSignupVerificationAction, EMPTY_FORM_STATE);
  const errors = state.fieldErrors ?? {};
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <TextField
        name="tenantSlug"
        label="Code établissement"
        required
        autoCapitalize="none"
        defaultValue={state.values?.tenantSlug ?? defaultTenant}
        error={errors.tenantSlug}
      />
      <TextField name="email" type="email" label="Adresse e-mail de l'administrateur" required autoComplete="username" defaultValue={state.values?.email} error={errors.email} />
      <SubmitButton pendingLabel="Envoi…">Renvoyer l&apos;e-mail de confirmation</SubmitButton>
    </form>
  );
}

/**
 * Confirmation par un clic explicite (docs/11 D1) : un scanner d'e-mails qui précharge le lien ne consomme pas le
 * jeton, puisque rien n'est envoyé à l'API tant que le bouton n'est pas actionné.
 */
export function ConfirmSignupForm({ token }: { readonly token: string }) {
  const [state, formAction] = useActionState(verifySignupAction, EMPTY_FORM_STATE);
  if (state.extra?.linkInvalid === true) {
    return (
      <div className="space-y-4">
        <FormMessage state={state} />
        <Link href="/inscription/verifier" className="inline-block font-semibold text-blue-800 underline">Recevoir un nouveau lien</Link>
      </div>
    );
  }
  return (
    <form action={formAction} className="space-y-4">
      <FormMessage state={state} />
      <input type="hidden" name="token" value={token} />
      <SubmitButton pendingLabel="Confirmation…">Confirmer mon adresse</SubmitButton>
    </form>
  );
}
