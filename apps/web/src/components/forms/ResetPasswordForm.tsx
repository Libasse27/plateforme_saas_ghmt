'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { resetPasswordAction } from '@/actions/password-reset';
import { EMPTY_FORM_STATE } from '@/lib/forms';
import { TextField } from '@/components/ui/Field';
import { FormMessage } from '@/components/ui/FormMessage';
import { SubmitButton } from '@/components/ui/SubmitButton';

export interface ResetPasswordFormProps {
  /** Jeton du lien reçu par e-mail : transmis dans le corps de la requête, jamais dans une URL d'API (D1). */
  readonly token: string;
  readonly tenantSlug: string;
  readonly emailMasked: string;
  /** Un second facteur est actif sur le compte : le code (ou un code de secours) est exigé. */
  readonly mfaRequired: boolean;
}

export function ResetPasswordForm({ token, tenantSlug, emailMasked, mfaRequired }: ResetPasswordFormProps) {
  const [state, formAction] = useActionState(resetPasswordAction, EMPTY_FORM_STATE);
  const errors = state.fieldErrors ?? {};

  if (state.extra?.linkInvalid === true) {
    return (
      <div className="space-y-4">
        <FormMessage state={state} />
        <Link href="/mot-de-passe-oublie" className="inline-block font-semibold text-blue-800 underline">Demander un nouveau lien</Link>
      </div>
    );
  }

  const askCode = mfaRequired || state.extra?.mfaRequired === true;
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <p className="text-sm text-slate-800">
        Compte : <strong>{emailMasked}</strong>, établissement <strong className="font-mono">{tenantSlug}</strong>.
      </p>
      <input type="hidden" name="token" value={token} />
      <input type="hidden" name="tenantSlug" value={tenantSlug} />
      <TextField
        name="newPassword"
        type="password"
        label="Nouveau mot de passe"
        hint="10 caractères minimum. Une phrase de passe longue est recommandée."
        required
        autoComplete="new-password"
        error={errors.newPassword}
      />
      <TextField name="confirmPassword" type="password" label="Confirmer le mot de passe" required autoComplete="new-password" error={errors.confirmPassword} />
      {askCode ? (
        <TextField
          name="mfaCode"
          label="Code de vérification"
          hint="Code à 6 chiffres de votre application d'authentification, ou un code de secours."
          required
          inputMode="text"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          error={errors.mfaCode}
        />
      ) : null}
      <SubmitButton pendingLabel="Enregistrement…">Modifier le mot de passe</SubmitButton>
    </form>
  );
}
