'use server';

import { redirect } from 'next/navigation';
import { fieldErrorsFromZod, formDataToFlat, type FormState } from '@/lib/forms';
import { acceptInvitationSchema, isInvitationToken } from '@/lib/schemas';
import { publicRequest } from '@/server/api';
import { failureState, invalidState } from './helpers';

/** Code établissement (même règle que l'inscription) : seul un code valide est repris dans l'URL de connexion. */
const TENANT_SLUG = /^(?=.{3,48}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const LOGIN_AFTER_ACCEPT = '/connexion?invitation=acceptee';

function loginPath(tenantSlug: string | undefined): string {
  return tenantSlug && TENANT_SLUG.test(tenantSlug) ? `${LOGIN_AFTER_ACCEPT}&etablissement=${tenantSlug}` : LOGIN_AFTER_ACCEPT;
}

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
  redirect(loginPath(flat.tenantSlug));
}
