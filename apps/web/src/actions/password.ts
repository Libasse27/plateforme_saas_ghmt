'use server';

import { redirect } from 'next/navigation';
import { fieldErrorsFromZod, formDataToFlat, type FormState } from '@/lib/forms';
import { changePasswordSchema } from '@/lib/schemas';
import { actionApi } from '@/server/api';
import { failureState, invalidState } from './helpers';

/** C7 : changement de mot de passe (les autres sessions sont révoquées par l'API). */
export async function changePasswordAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const errors: Record<string, string> = {};
  const parsed = changePasswordSchema.safeParse({ currentPassword: flat.currentPassword ?? '', newPassword: flat.newPassword ?? '' });
  if (!parsed.success) Object.assign(errors, fieldErrorsFromZod(parsed.error));
  if ((flat.newPassword ?? '') !== (flat.confirmPassword ?? '')) errors.confirmPassword = 'Les mots de passe ne correspondent pas.';
  if (!parsed.success || Object.keys(errors).length > 0) return invalidState(errors, {});

  try {
    await actionApi('/auth/password/change', { method: 'POST', body: parsed.data });
  } catch (error) {
    return failureState(error);
  }
  redirect('/');
}
