import { cache } from 'react';
import { redirect } from 'next/navigation';
import { parsePlatformMe, platformStepPath, type PlatformMeView } from '@/lib/auth/platform-me';
import { platformPageApi } from './platform-api';

/** Profil plateforme courant, dédupliqué sur la durée d'une requête. */
export const getPlatformMe = cache(async (): Promise<PlatformMeView> => {
  const { data } = await platformPageApi<unknown>('/platform/auth/me');
  return parsePlatformMe(data);
});

/** Console plateforme : redirige vers l'enrôlement/la vérification MFA tant que la session n'est pas vérifiée. */
export async function requirePlatformMe(options: { readonly allowMfaPending?: boolean } = {}): Promise<PlatformMeView> {
  const me = await getPlatformMe();
  const step = platformStepPath(me);
  if (step && !options.allowMfaPending) redirect(step);
  return me;
}
