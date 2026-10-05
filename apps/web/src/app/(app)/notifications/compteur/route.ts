import { NextResponse } from 'next/server';
import { requestWithSession } from '@/lib/api/client';
import { isApiError } from '@/lib/api/errors';
import { toUnreadCount } from '@/lib/domain/notifications';
import { apiDeps } from '@/server/api';
import { cookieTokenStore } from '@/lib/session/store';

export const dynamic = 'force-dynamic';

const NO_STORE = { 'cache-control': 'no-store' } as const;
const UNAVAILABLE_STATUS = 503;

/**
 * Compteur de la cloche, interrogé toutes les 60 s par le navigateur. Le jeton reste dans le cookie httpOnly :
 * le navigateur ne le voit jamais. Un 401 est transmis tel quel (aucune redirection) pour que la cloche s'arrête.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const { data } = await requestWithSession(await apiDeps(), cookieTokenStore({ persist: false }), '/notifications/inbox/unread-count');
    return NextResponse.json(toUnreadCount(data), { headers: NO_STORE });
  } catch (error) {
    if (!isApiError(error)) throw error;
    const status = error.status >= 400 ? error.status : UNAVAILABLE_STATUS;
    return NextResponse.json({ error: 'unavailable' }, { status, headers: NO_STORE });
  }
}
