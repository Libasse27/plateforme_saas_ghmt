import type { Metadata } from 'next';
import { DashboardStats } from '@/components/platform/DashboardStats';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Alert } from '@/components/ui/Alert';
import { PageHeader } from '@/components/ui/PageHeader';
import { settle } from '@/lib/api/settle';
import { hasPlatformPermission } from '@/lib/auth/platform-me';
import { toPlatformDashboard } from '@/lib/domain/platform';
import { platformPageApi } from '@/server/platform-api';
import { requirePlatformMe } from '@/server/platform-me';

export const metadata: Metadata = { title: 'Tableau de bord' };

export default async function PlatformDashboardPage() {
  const me = await requirePlatformMe();
  if (!hasPlatformPermission(me, 'dashboard:read')) return <AccessDenied what="le tableau de bord plateforme" />;
  const result = await settle(() => platformPageApi('/platform/dashboard'));
  return (
    <>
      <PageHeader title="Tableau de bord" description="Vue d'ensemble de la plateforme (aucune donnée patient)." />
      {result.ok ? <DashboardStats dashboard={toPlatformDashboard(result.value.data)} /> : <Alert tone="error">{result.message}</Alert>}
    </>
  );
}
