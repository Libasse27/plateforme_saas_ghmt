import { PRIVILEGED_PASSWORD_MIN_LENGTH, signupTenantSchema } from '@ghmt/shared';
import { fieldErrorsFromZod, nestFlat } from './forms';

export const SIGNUP_STEPS = [
  { key: 'establishment', title: 'Établissement' },
  { key: 'mainSite', title: 'Site principal' },
  { key: 'admin', title: 'Administrateur' },
] as const;

export type SignupStepKey = (typeof SIGNUP_STEPS)[number]['key'];

const STEP_SCHEMAS = {
  establishment: signupTenantSchema.shape.establishment,
  mainSite: signupTenantSchema.shape.mainSite,
  admin: signupTenantSchema.shape.admin,
} as const;

/** Valide une étape de l'assistant avec le sous-schéma partagé ; clés d'erreur au format `étape.champ`. */
export function validateSignupStep(step: SignupStepKey, flat: Readonly<Record<string, string>>): Record<string, string> {
  const nested = nestFlat(flat)[step];
  const result = STEP_SCHEMAS[step].safeParse(typeof nested === 'object' ? nested : {});
  const errors: Record<string, string> = result.success
    ? {}
    : Object.fromEntries(Object.entries(fieldErrorsFromZod(result.error)).map(([path, message]) => [`${step}.${path}`, message]));
  if (step === 'admin' && flat['admin.password'] !== flat['admin.confirmPassword']) {
    errors['admin.confirmPassword'] = 'Les mots de passe ne correspondent pas.';
  }
  return errors;
}

/** Étape contenant la première erreur (pour y ramener l'utilisateur après un refus du serveur). */
export function stepIndexOfFirstError(fieldErrors: Readonly<Record<string, string>>): number {
  const firstKey = Object.keys(fieldErrors)[0];
  if (!firstKey) return 0;
  const index = SIGNUP_STEPS.findIndex((s) => firstKey.startsWith(`${s.key}.`));
  return index === -1 ? 0 : index;
}

export const ADMIN_PASSWORD_HINT = `${PRIVILEGED_PASSWORD_MIN_LENGTH} caractères minimum.`;
