import { cache } from 'react';
import { redirect } from 'next/navigation';
import { parseMe, requiredStepPath, type Me, type StepOptions } from '@/lib/auth/me';
import { pageApi } from './api';

/** Profil courant, dédupliqué sur la durée d'une requête (layout + page). */
export const getMe = cache(async (): Promise<Me> => {
  const { data } = await pageApi<unknown>('/auth/me');
  return parseMe(data);
});

/** Redirige vers l'étape obligatoire : mot de passe à changer (C7) avant l'enrôlement MFA. */
export async function requireMe(options: StepOptions = {}): Promise<Me> {
  const me = await getMe();
  const step = requiredStepPath(me, options);
  if (step) redirect(step);
  return me;
}
