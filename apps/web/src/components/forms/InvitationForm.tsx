'use client';

import { useActionState } from 'react';
import { acceptInvitationAction } from '@/actions/invitation';
import { TextField } from '@/components/ui/Field';
import { FormMessage } from '@/components/ui/FormMessage';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { EMPTY_FORM_STATE } from '@/lib/forms';

export interface InvitationFormProps {
  readonly token: string;
  /** Code établissement de l'invitation, repris pour pré-remplir la connexion. */
  readonly tenantSlug?: string;
}

export function InvitationForm({ token, tenantSlug }: InvitationFormProps) {
  const [state, formAction] = useActionState(acceptInvitationAction, EMPTY_FORM_STATE);
  const errors = state.fieldErrors ?? {};
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="token" value={token} />
      {tenantSlug ? <input type="hidden" name="tenantSlug" value={tenantSlug} /> : null}
      <TextField
        name="password"
        type="password"
        label="Mot de passe"
        hint="10 caractères minimum. Une phrase de passe longue est recommandée."
        required
        autoComplete="new-password"
        error={errors.password}
      />
      <TextField name="confirmPassword" type="password" label="Confirmer le mot de passe" required autoComplete="new-password" error={errors.confirmPassword} />
      <SubmitButton pendingLabel="Enregistrement…">Définir mon mot de passe</SubmitButton>
    </form>
  );
}
