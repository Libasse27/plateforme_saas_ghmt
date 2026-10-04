import type { ReactNode } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { requireMe } from '@/server/me';
import { loadSubscriptionBanner } from '@/server/subscription';

export default async function AppLayout({ children }: { readonly children: ReactNode }) {
  const me = await requireMe();
  const banner = await loadSubscriptionBanner(me);
  return <AppShell me={me} banner={banner}>{children}</AppShell>;
}
