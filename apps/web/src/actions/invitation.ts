'use server';

import { redirect } from 'next/navigation';
import { fieldErrorsFromZod, formDataToFlat, type FormState } from '@/lib/forms';
import { acceptInvitationSchema, isInvitationToken } from '@/lib/schemas';
import { publicRequest } from '@/server/api';
import { failureState, invalidState } from './helpers';

/** C6 : l'invité définit son mot de passe ; le jeton à usage unique reste dans le chemin de l'appel. */
export async function acceptInvitationAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const token = flat.token ?? '';
  if (!isInvitationToken(token)) return { ok: false, message: 'Lien d\'invitation invalide.' };

  const errors: Record<string, string> = {};
  const parsed = acceptInvitationSchema.safeParse({ password: flat.password ?? '' });
  if (!parsed.success) Object.assign(errors, fieldErrorsFromZod(parsed.error));
  if ((flat.password ?? '') !== (flat.confirmPassword ?? '')) errors.confirmPassword = 'Les mots de passe ne correspondent pas.';
  if (!parsed.success || Object.keys(errors).length > 0) return invalidState(errors, {});

  try {
    await publicRequest(`/auth/invitations/${encodeURIComponent(token)}/accept`, { method: 'POST', body: parsed.data });
  } catch (error) {
    return failureState(error);
  }
  redirect('/connexion?invitation=acceptee');
}
