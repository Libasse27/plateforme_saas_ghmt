import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { PlatformShell } from '@/components/layout/PlatformShell';
import { requirePlatformMe } from '@/server/platform-me';

export const metadata: Metadata = { title: { default: 'GHMT - Console plateforme', template: '%s | GHMT Plateforme' } };

export default async function PlatformAppLayout({ children }: { readonly children: ReactNode }) {
  const me = await requirePlatformMe();
  return <PlatformShell me={me}>{children}</PlatformShell>;
}
