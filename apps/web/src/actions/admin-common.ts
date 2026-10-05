import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import type { FormState } from '@/lib/forms';
import type { FormResult } from '@/lib/domain/admin-forms';
import { actionApi } from '@/server/api';
import { failureState, invalidState } from './helpers';

export interface Mutation {
  readonly path: string;
  readonly method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly body?: unknown;
  /** Valeurs saisies renvoyées au formulaire en cas d'échec (jamais de secret). */
  readonly values?: Readonly<Record<string, string>>;
  /** Pages à revalider après succès. */
  readonly revalidate: readonly string[];
  readonly message: string;
  /** Redirection après succès (suppression d'une fiche, par exemple). */
  readonly redirectTo?: string;
}

/** Appel d'écriture + revalidation + état de formulaire français ; la redirection se fait hors du try (elle lève). */
export async function runMutation(mutation: Mutation): Promise<FormState> {
  try {
    await actionApi(mutation.path, { method: mutation.method, ...(mutation.body !== undefined ? { body: mutation.body } : {}) });
  } catch (error) {
    return failureState(error, mutation.values);
  }
  for (const path of mutation.revalidate) revalidatePath(path);
  if (mutation.redirectTo) redirect(mutation.redirectTo);
  return { ok: true, message: mutation.message };
}

/** Validation locale : l'état d'erreur de champ à renvoyer, ou la charge utile à envoyer. */
export function checked<T>(result: FormResult<T>, values: Record<string, string>): { readonly state: FormState } | { readonly data: T } {
  return result.ok ? { data: result.data } : { state: invalidState(result.errors, values) };
}
