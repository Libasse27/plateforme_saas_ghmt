import type { Metadata } from 'next';
import { DashboardCards } from '@/components/admin/DashboardCards';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Alert } from '@/components/ui/Alert';
import { PageHeader } from '@/components/ui/PageHeader';
import { buttonClass, inputClass } from '@/components/ui/styles';
import { settle } from '@/lib/api/settle';
import { hasPermission } from '@/lib/auth/me';
import { firstValues, siteOptionLabel, toDashboard, toSiteAdmin } from '@/lib/domain/admin';
import { isUuid } from '@/lib/domain/raw';
import { formatLongDay } from '@/lib/format/dates';
import { pageApi } from '@/server/api';
import { requireMe } from '@/server/me';
import { loadOptional } from './_lib/page-data';

export const metadata: Metadata = { title: 'Tableau de bord de l\'établissement' };

export default async function AdministrationPage({ searchParams }: { readonly searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireMe();
  if (!hasPermission(me, 'reports:dashboard:read')) return <AccessDenied what="le tableau de bord de l'établissement" />;
  const params = firstValues(await searchParams);
  const siteId = isUuid(params.site) ? params.site : undefined;
  const [result, sites] = await Promise.all([
    settle(() => pageApi('/dashboards/establishment', siteId ? { query: { siteId } } : {})),
    loadOptional(hasPermission(me, 'org:site:read'), '/org/sites', toSiteAdmin),
  ]);
  const dashboard = result.ok ? toDashboard(result.value.data) : null;

  return (
    <>
      <PageHeader title="Tableau de bord de l'établissement" description={dashboard?.date ? `Situation du ${formatLongDay(dashboard.date)} (comptes uniquement, aucune donnée nominative).` : 'Situation du jour (comptes uniquement).'} />
      {sites.length > 1 ? (
        <form method="get" className="mb-6 flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor="site" className="mb-1 block text-sm font-medium">Site</label>
            <select id="site" name="site" defaultValue={siteId ?? ''} className={inputClass}>
              <option value="">Tous les sites</option>
              {sites.map((site) => <option key={site.id} value={site.id}>{siteOptionLabel(site)}</option>)}
            </select>
          </div>
          <button type="submit" className={buttonClass.primary}>Afficher</button>
        </form>
      ) : null}
      {dashboard ? <DashboardCards dashboard={dashboard} timeZone={me.tenant.timezone} /> : <Alert tone="error">{result.ok ? 'Chargement impossible.' : result.message}</Alert>}
    </>
  );
}
