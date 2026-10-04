import { cache } from 'react';
import { hasPermission, type Me } from '@/lib/auth/me';
import { settle } from '@/lib/api/settle';
import { subscriptionBanner, toSubscription, type Banner } from '@/lib/domain/subscription';
import { pageApi } from './api';

/** Abonnement courant, dédupliqué sur la durée d'une requête ; null si l'appelant n'a pas le droit ou n'a pas d'abonnement. */
export const getSubscription = cache(async (canRead: boolean) => {
  if (!canRead) return null;
  const result = await settle(() => pageApi('/subscription'));
  return result.ok ? toSubscription(result.value.data) : null;
});

/** Bandeau global (retard, grâce, suspension) ; ne bloque jamais le rendu en cas d'erreur de l'API. */
export async function loadSubscriptionBanner(me: Me): Promise<Banner | null> {
  const subscription = await getSubscription(hasPermission(me, 'settings:establishment:read'));
  return subscription ? subscriptionBanner(subscription.status) : null;
}
