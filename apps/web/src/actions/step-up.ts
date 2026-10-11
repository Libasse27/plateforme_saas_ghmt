import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { request, type RequestOptions } from '@/lib/api/client';
import { isApiError } from '@/lib/api/errors';
import { describeApiError } from '@/lib/api/messages';
import type { ApiSuccess } from '@/lib/api/types';
import type { FormState } from '@/lib/forms';
import { cookieTokenStore } from '@/lib/session/store';
import { apiDeps, actionApi } from '@/server/api';
import type { Mutation } from './admin-common';
import { failureState } from './helpers';

/**
 * Opérations de pouvoir (docs/11 §14.1) : l'API répond 401 `mfa_step_up_required` / `mfa_code_invalid` quand le code du
 * second facteur manque ou est faux. `actionApi` traiterait tout 401 comme une session perdue (rafraîchissement, puis
 * renvoi vers la connexion) : ces deux codes doivent au contraire revenir au formulaire, sur le champ du code.
 */
const STEP_UP_CODES: ReadonlySet<string> = new Set(['mfa_step_up_required', 'mfa_code_invalid']);

/** Valeurs à renvoyer au formulaire : jamais le code du second facteur. */
export function withoutTotpCode(values: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([key]) => key !== 'totpCode'));
}

type SessionRequest = Omit<RequestOptions, 'accessToken'>;

/**
 * Un premier appel direct avec le jeton d'accès courant, sans rejeu : un code faux n'est donc compté qu'une fois. Tout
 * autre 401 (jeton expiré) retombe sur le parcours habituel de `actionApi` (rafraîchissement, puis rejeu).
 */
export async function stepUpRequest(path: string, options: SessionRequest = {}): Promise<ApiSuccess<unknown>> {
  const { accessToken } = await cookieTokenStore({ persist: true }).read();
  if (accessToken) {
    try {
      return await request(await apiDeps(), path, { ...options, accessToken });
    } catch (error) {
      if (!(isApiError(error) && error.status === 401 && !STEP_UP_CODES.has(error.code))) throw error;
    }
  }
  return actionApi(path, options);
}

/** Comme `runMutation`, avec le traitement du code du second facteur. */
export async function runStepUpMutation(mutation: Mutation): Promise<FormState> {
  const values = mutation.values ? withoutTotpCode(mutation.values) : undefined;
  try {
    await stepUpRequest(mutation.path, { method: mutation.method, ...(mutation.body !== undefined ? { body: mutation.body } : {}) });
  } catch (error) {
    if (isApiError(error) && STEP_UP_CODES.has(error.code)) {
      const message = describeApiError(error);
      return { ok: false, message, fieldErrors: { totpCode: message }, values };
    }
    return failureState(error, values);
  }
  for (const path of mutation.revalidate) revalidatePath(path);
  if (mutation.redirectTo) redirect(mutation.redirectTo);
  return { ok: true, message: mutation.message };
}
