import type { Metadata } from 'next';
import Link from 'next/link';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Cell, DataTable } from '@/components/ui/DataTable';
import { PageHeader } from '@/components/ui/PageHeader';
import { buttonClass, inputClass } from '@/components/ui/styles';
import { settle } from '@/lib/api/settle';
import { hasPlatformPermission } from '@/lib/auth/platform-me';
import { TENANT_STATUS_LABELS, toTenantSummary } from '@/lib/domain/platform';
import { isUuid, items } from '@/lib/domain/raw';
import { STATUS_LABELS } from '@/lib/domain/subscription';
import { platformPageApi } from '@/server/platform-api';
import { requirePlatformMe } from '@/server/platform-me';
import { SUBSCRIPTION_STATUSES, TENANT_STATUSES } from '@ghmt/shared';

export const metadata: Metadata = { title: 'Établissements' };

const PAGE_SIZE = 20;

interface Search {
  q?: string;
  status?: string;
  subscriptionStatus?: string;
  cursor?: string;
}

function pick<T extends string>(allowed: readonly T[], value: string | undefined): T | undefined {
  return allowed.find((candidate) => candidate === value);
}

function pageHref(filters: Readonly<Record<string, string | undefined>>, cursor: string | null): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) if (value) search.set(key, value);
  if (cursor) search.set('cursor', cursor);
  const qs = search.toString();
  return qs ? `/plateforme/etablissements?${qs}` : '/plateforme/etablissements';
}

export default async function TenantsPage({ searchParams }: { readonly searchParams: Promise<Search> }) {
  const me = await requirePlatformMe();
  if (!hasPlatformPermission(me, 'tenants:read')) return <AccessDenied what="la liste des établissements" />;
  const params = await searchParams;
  const filters = {
    q: params.q?.trim().slice(0, 100) || undefined,
    status: pick(TENANT_STATUSES, params.status),
    subscriptionStatus: pick(SUBSCRIPTION_STATUSES, params.subscriptionStatus),
  };
  const cursor = isUuid(params.cursor) ? params.cursor : undefined;

  const result = await settle(() => platformPageApi('/platform/tenants', { query: { ...filters, cursor, limit: PAGE_SIZE } }));
  const pagination = result.ok ? result.value.meta.pagination : undefined;
  const nextCursor = pagination?.hasMore ? pagination.nextCursor : null;
  const tenants = result.ok ? items(result.value.data, toTenantSummary) : [];

  return (
    <>
      <PageHeader title="Établissements" />
      <form method="get" className="mb-6 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="q" className="mb-1 block text-sm font-medium">Nom ou code</label>
          <input id="q" name="q" type="search" defaultValue={filters.q ?? ''} className={inputClass} />
        </div>
        <div>
          <label htmlFor="status" className="mb-1 block text-sm font-medium">Statut</label>
          <select id="status" name="status" defaultValue={filters.status ?? ''} className={inputClass}>
            <option value="">Tous</option>
            {Object.entries(TENANT_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="subscriptionStatus" className="mb-1 block text-sm font-medium">Abonnement</label>
          <select id="subscriptionStatus" name="subscriptionStatus" defaultValue={filters.subscriptionStatus ?? ''} className={inputClass}>
            <option value="">Tous</option>
            {Object.entries(STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
        </div>
        <button type="submit" className={buttonClass.primary}>Filtrer</button>
      </form>
      {!result.ok ? <Alert tone="error">{result.message}</Alert> : null}
      {result.ok && tenants.length === 0 ? <p className="text-slate-700">Aucun établissement ne correspond à ces critères.</p> : null}
      {tenants.length > 0 ? (
        <DataTable caption="Établissements" columns={[{ header: 'Établissement' }, { header: 'Pays' }, { header: 'Statut' }, { header: 'Plan' }, { header: 'Abonnement' }]}>
          {tenants.map((tenant) => (
            <tr key={tenant.id}>
              <Cell>
                <Link href={`/plateforme/etablissements/${encodeURIComponent(tenant.id)}`} className="font-semibold text-blue-800 underline">{tenant.name}</Link>
                <span className="block text-xs text-slate-700">{tenant.slug}</span>
              </Cell>
              <Cell>{tenant.countryCode}</Cell>
              <Cell><Badge tone={tenant.status === 'active' ? 'success' : tenant.status === 'suspended' ? 'danger' : 'neutral'}>{TENANT_STATUS_LABELS[tenant.status] ?? tenant.status}</Badge></Cell>
              <Cell>{tenant.subscription?.planCode ?? '-'}</Cell>
              <Cell>{tenant.subscription ? (STATUS_LABELS[tenant.subscription.status as keyof typeof STATUS_LABELS] ?? tenant.subscription.status) : '-'}</Cell>
            </tr>
          ))}
        </DataTable>
      ) : null}
      {cursor || nextCursor ? (
        <nav aria-label="Pagination" className="mt-4 flex gap-3">
          {cursor ? <Link href={pageHref(filters, null)} className={buttonClass.secondary}>Retour au début</Link> : null}
          {nextCursor ? <Link href={pageHref(filters, nextCursor)} className={buttonClass.secondary}>Page suivante</Link> : null}
        </nav>
      ) : null}
    </>
  );
}
