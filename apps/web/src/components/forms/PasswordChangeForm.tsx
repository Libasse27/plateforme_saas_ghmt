'use client';

import { useActionState } from 'react';
import { changePasswordAction } from '@/actions/password';
import { TextField } from '@/components/ui/Field';
import { FormMessage } from '@/components/ui/FormMessage';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { EMPTY_FORM_STATE } from '@/lib/forms';

export function PasswordChangeForm() {
  const [state, formAction] = useActionState(changePasswordAction, EMPTY_FORM_STATE);
  const errors = state.fieldErrors ?? {};
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <TextField name="currentPassword" type="password" label="Mot de passe actuel" required autoComplete="current-password" error={errors.currentPassword} />
      <TextField
        name="newPassword"
        type="password"
        label="Nouveau mot de passe"
        hint="10 caractères minimum. Une phrase de passe longue est recommandée."
        required
        autoComplete="new-password"
        error={errors.newPassword}
      />
      <TextField name="confirmPassword" type="password" label="Confirmer le nouveau mot de passe" required autoComplete="new-password" error={errors.confirmPassword} />
      <SubmitButton pendingLabel="Enregistrement…">Changer le mot de passe</SubmitButton>
    </form>
  );
}
