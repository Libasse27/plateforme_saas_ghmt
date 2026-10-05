import type { Metadata } from 'next';
import { DepartmentsPanel } from '@/components/admin/DepartmentsPanel';
import { SitesPanel } from '@/components/admin/SitesPanel';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Alert } from '@/components/ui/Alert';
import { PageHeader } from '@/components/ui/PageHeader';
import { hasPermission } from '@/lib/auth/me';
import { toDepartment, toSiteAdmin } from '@/lib/domain/admin';
import { requireMe } from '@/server/me';
import { loadList, loadOptional } from '../_lib/page-data';

export const metadata: Metadata = { title: 'Organisation' };

export default async function OrganisationPage() {
  const me = await requireMe();
  if (!hasPermission(me, 'org:site:read')) return <AccessDenied what="l'organisation de l'établissement" />;
  const [sites, departments] = await Promise.all([
    loadList('/org/sites', toSiteAdmin),
    loadOptional(hasPermission(me, 'org:service:read'), '/org/departments', toDepartment),
  ]);
  if (!sites.ok) return <Alert tone="error">{sites.message}</Alert>;
  const canEditSite = hasPermission(me, 'org:site:update') || hasPermission(me, 'org:site:delete');
  const canEditDepartment = hasPermission(me, 'org:service:update') || hasPermission(me, 'org:service:delete');

  return (
    <>
      <PageHeader title="Organisation" description="Sites et services de l'établissement." />
      <div className="space-y-8">
        <SitesPanel sites={sites.value} canCreate={hasPermission(me, 'org:site:create')} canEdit={canEditSite} defaultTimezone={me.tenant.timezone} defaultCountry={me.tenant.countryCode} />
        {hasPermission(me, 'org:service:read') ? (
          <DepartmentsPanel sites={sites.value} departments={departments} canCreate={hasPermission(me, 'org:service:create')} canEdit={canEditDepartment} />
        ) : null}
      </div>
    </>
  );
}
