import type { ReactNode } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { hasPermission } from '@/lib/auth/me';
import { requireMe } from '@/server/me';
import { loadSubscriptionBanner } from '@/server/subscription';

export default async function AppLayout({ children }: { readonly children: ReactNode }) {
  const me = await requireMe();
  const banner = await loadSubscriptionBanner();
  return <AppShell me={me} banner={banner} canManageSubscription={hasPermission(me, 'settings:establishment:read')}>{children}</AppShell>;
}
