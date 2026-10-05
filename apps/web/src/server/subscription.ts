import { cache } from 'react';
import { settle } from '@/lib/api/settle';
import { statusBanner, toSubscription, toSubscriptionStatus, type Banner } from '@/lib/domain/subscription';
import { pageApi } from './api';

/** Abonnement courant, dédupliqué sur la durée d'une requête ; null si l'appelant n'a pas le droit ou n'a pas d'abonnement. */
export const getSubscription = cache(async (canRead: boolean) => {
  if (!canRead) return null;
  const result = await settle(() => pageApi('/subscription'));
  return result.ok ? toSubscription(result.value.data) : null;
});

/** Bandeau global pour TOUT utilisateur authentifié (R1) ; ne bloque jamais le rendu en cas d'erreur de l'API. */
export async function loadSubscriptionBanner(): Promise<Banner | null> {
  const result = await settle(() => pageApi('/subscription/status'));
  if (!result.ok) return null;
  const view = toSubscriptionStatus(result.value.data);
  return view ? statusBanner(view) : null;
}
