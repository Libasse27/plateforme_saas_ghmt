import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { request, requestWithSession, type ClientDeps, type RequestOptions } from '@/lib/api/client';
import { extractClientInfo } from '@/lib/api/client-info';
import { isApiError } from '@/lib/api/errors';
import type { ApiSuccess } from '@/lib/api/types';
import { getApiUrl } from '@/lib/config';
import { cookieTokenStore } from '@/lib/session/store';

type SessionRequest = Omit<RequestOptions, 'accessToken'>;

/**
 * C9 : l'IP du client final est lue sur la requête entrante (x-forwarded-for du proxy amont,
 * sinon x-real-ip), jamais fournie par le navigateur, puis transmise à l'API.
 */
export async function apiDeps(): Promise<ClientDeps> {
  return { baseUrl: getApiUrl(), clientInfo: extractClientInfo(await headers()) };
}

/**
 * Rendu serveur (pages) : cookies en lecture seule, donc pas de rafraîchissement ici
 * (le proxy s'en charge avant le rendu). Une 401 renvoie vers /session/expire qui purge les cookies.
 */
export async function pageApi<T = unknown>(path: string, options: SessionRequest = {}): Promise<ApiSuccess<T>> {
  try {
    return await requestWithSession<T>(await apiDeps(), cookieTokenStore({ persist: false }), path, options);
  } catch (error) {
    if (isApiError(error) && error.status === 401) redirect('/session/expire');
    throw error;
  }
}

/**
 * Server Actions : rafraîchit une seule fois sur 401 et persiste les nouveaux cookies.
 * Si la session est définitivement perdue, retourne vers la connexion.
 */
export async function actionApi<T = unknown>(path: string, options: SessionRequest = {}): Promise<ApiSuccess<T>> {
  try {
    return await requestWithSession<T>(await apiDeps(), cookieTokenStore({ persist: true }), path, options);
  } catch (error) {
    if (isApiError(error) && error.status === 401) redirect('/connexion?session=expiree');
    throw error;
  }
}

/** Appel public (login, signup, MFA, invitation, déconnexion) sans session. */
export async function publicRequest<T = unknown>(path: string, options: Omit<RequestOptions, 'accessToken'> = {}): Promise<ApiSuccess<T>> {
  return request<T>(await apiDeps(), path, options);
}
