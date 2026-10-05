import { redirect } from 'next/navigation';
import { request, requestWithSession, type RequestOptions } from '@/lib/api/client';
import { isApiError } from '@/lib/api/errors';
import { PLATFORM_REFRESH_PATH } from '@/lib/api/refresh';
import type { ApiSuccess } from '@/lib/api/types';
import { platformTokenStore } from '@/lib/session/platform-store';
import { apiDeps } from './api';

type SessionRequest = Omit<RequestOptions, 'accessToken'>;

async function platformDeps() {
  return { ...(await apiDeps()), refreshPath: PLATFORM_REFRESH_PATH };
}

/** Rendu serveur de la console plateforme : cookies plateforme en lecture seule (le proxy rafraîchit avant le rendu). */
export async function platformPageApi<T = unknown>(path: string, options: SessionRequest = {}): Promise<ApiSuccess<T>> {
  try {
    return await requestWithSession<T>(await platformDeps(), platformTokenStore({ persist: false }), path, options);
  } catch (error) {
    if (isApiError(error) && error.status === 401) redirect('/plateforme/session/expire');
    throw error;
  }
}

/** Server Actions plateforme : rafraîchit une fois sur 401 et persiste les nouveaux cookies plateforme. */
export async function platformActionApi<T = unknown>(path: string, options: SessionRequest = {}): Promise<ApiSuccess<T>> {
  try {
    return await requestWithSession<T>(await platformDeps(), platformTokenStore({ persist: true }), path, options);
  } catch (error) {
    if (isApiError(error) && error.status === 401) redirect('/plateforme/connexion?session=expiree');
    throw error;
  }
}

/** Appel plateforme sans session (connexion, vérification MFA, déconnexion). */
export async function platformPublicRequest<T = unknown>(path: string, options: Omit<RequestOptions, 'accessToken'> = {}): Promise<ApiSuccess<T>> {
  return request<T>(await platformDeps(), path, options);
}
