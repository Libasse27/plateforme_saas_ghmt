import type { ReactNode } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { settle } from '@/lib/api/settle';
import { hasPermission } from '@/lib/auth/me';
import { toUnreadCount } from '@/lib/domain/notifications';
import { pageApi } from '@/server/api';
import { requireMe } from '@/server/me';
import { loadSubscriptionBanner } from '@/server/subscription';

/** Compteur initial de la cloche : un échec ne bloque jamais la page (cloche sans nombre). */
async function loadUnread() {
  const result = await settle(() => pageApi('/notifications/inbox/unread-count'));
  return result.ok ? toUnreadCount(result.value.data) : null;
}

export default async function AppLayout({ children }: { readonly children: ReactNode }) {
  const me = await requireMe();
  const [banner, unread] = await Promise.all([loadSubscriptionBanner(), loadUnread()]);
  return (
    <AppShell me={me} banner={banner} unread={unread} canManageSubscription={hasPermission(me, 'settings:establishment:read')}>
      {children}
    </AppShell>
  );
}
