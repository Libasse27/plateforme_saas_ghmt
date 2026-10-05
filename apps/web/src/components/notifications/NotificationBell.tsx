'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { backoffDelay, badgeLabel, toUnreadCount, type UnreadCountView } from '@/lib/domain/notifications';

const COUNTER_URL = '/notifications/compteur';

function accessibleName(label: string | null, count: number): string {
  if (!label) return 'Notifications';
  return `Notifications, ${label} non ${count === 1 && label === '1' ? 'lue' : 'lues'}`;
}

/** Interroge le compteur ; une session perdue (401) arrête le polling, toute autre panne le ralentit. */
async function fetchCount(onCount: (count: UnreadCountView) => void): Promise<'ok' | 'failed' | 'unauthorized'> {
  try {
    const response = await fetch(COUNTER_URL, { cache: 'no-store', credentials: 'same-origin' });
    if (response.status === 401) return 'unauthorized';
    if (!response.ok) return 'failed';
    onCount(toUnreadCount(await response.json()));
    return 'ok';
  } catch {
    return 'failed';
  }
}

/** Polling du compteur toutes les 60 s : suspendu onglet masqué, backoff jusqu'à 5 min sur erreur, arrêt sur 401. */
function useUnreadPolling(onCount: (count: UnreadCountView) => void): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let stopped = false;

    const schedule = (): void => {
      clearTimeout(timer);
      if (stopped || document.hidden) return;
      timer = setTimeout(() => void poll(), backoffDelay(failures));
    };
    const poll = async (): Promise<void> => {
      const outcome = await fetchCount(onCount);
      if (outcome === 'unauthorized') {
        stopped = true;
        return;
      }
      failures = outcome === 'ok' ? 0 : failures + 1;
      schedule();
    };
    const onVisibility = (): void => {
      clearTimeout(timer);
      if (!document.hidden && !stopped) void poll();
    };

    schedule();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [onCount]);
}

export function NotificationBell({ initial }: { readonly initial: UnreadCountView | null }) {
  const [unread, setUnread] = useState<UnreadCountView | null>(initial);
  // Resynchronisation avec le serveur (compteur relu par le layout après une mutation), sans effet.
  const serverKey = initial ? `${String(initial.count)}:${String(initial.capped)}` : '';
  const [syncedKey, setSyncedKey] = useState(serverKey);
  if (serverKey !== syncedKey) {
    setSyncedKey(serverKey);
    setUnread(initial);
  }
  useUnreadPolling(setUnread);

  const label = unread ? badgeLabel(unread) : null;
  return (
    <Link href="/notifications" aria-label={accessibleName(label, unread?.count ?? 0)} className="relative inline-flex items-center rounded-md p-2 text-slate-900 hover:bg-slate-200">
      <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
        <path d="M13.7 21a2 2 0 0 1-3.4 0" />
      </svg>
      {label ? (
        <span aria-hidden="true" className="absolute -right-1 -top-1 min-w-5 rounded-full bg-red-700 px-1.5 text-center text-xs font-bold text-white">
          {label}
        </span>
      ) : null}
    </Link>
  );
}
