import type { ReactNode } from 'react';
import { AppShell } from '@/components/layout/AppShell';
import { requireMe } from '@/server/me';

export default async function AppLayout({ children }: { readonly children: ReactNode }) {
  const me = await requireMe();
  return <AppShell me={me}>{children}</AppShell>;
}
