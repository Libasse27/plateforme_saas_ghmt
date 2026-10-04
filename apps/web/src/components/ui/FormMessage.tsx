import type { FormState } from '@/lib/forms';
import { Alert } from './Alert';

/** Message global d'un formulaire : erreur (role=alert) ou succès (role=status). */
export function FormMessage({ state }: { readonly state: FormState }) {
  if (!state.message) return null;
  return <Alert tone={state.ok ? 'success' : 'error'}>{state.message}</Alert>;
}
