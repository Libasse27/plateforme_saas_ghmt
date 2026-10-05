import type { Metadata } from 'next';
import Link from 'next/link';
import { PlanVersionForm } from '@/components/platform/PlanVersionForm';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Cell, DataTable } from '@/components/ui/DataTable';
import { PageHeader } from '@/components/ui/PageHeader';
import { settle } from '@/lib/api/settle';
import { hasPlatformPermission } from '@/lib/auth/platform-me';
import { formatMoney } from '@/lib/domain/money';
import { toPlatformPlan } from '@/lib/domain/platform';
import { items } from '@/lib/domain/raw';
import { platformPageApi } from '@/server/platform-api';
import { requirePlatformMe } from '@/server/platform-me';

export const metadata: Metadata = { title: 'Plans' };

const PLAN_CODE = /^[a-z0-9_]{2,50}$/;

export default async function PlansPage({ searchParams }: { readonly searchParams: Promise<{ archives?: string; base?: string }> }) {
  const me = await requirePlatformMe();
  if (!hasPlatformPermission(me, 'plans:read')) return <AccessDenied what="les plans" />;
  const canWrite = hasPlatformPermission(me, 'plans:write');
  const params = await searchParams;
  const includeArchived = params.archives === '1';

  const result = await settle(() => platformPageApi('/platform/plans', { query: { includeArchived } }));
  if (!result.ok) return <Alert tone="error">{result.message}</Alert>;
  const plans = items(result.value.data, toPlatformPlan);
  const baseCode = params.base && PLAN_CODE.test(params.base) ? params.base : undefined;
  const base = baseCode ? plans.find((plan) => plan.code === baseCode && plan.archivedAt === null) : undefined;
  const limit = (value: number | null): string => (value === null ? '∞' : String(value));

  return (
    <>
      <PageHeader title="Plans" description="Offres versionnées : publier une nouvelle version archive la précédente." />
      <div className="space-y-8">
        <p>
          <Link href={includeArchived ? '/plateforme/plans' : '/plateforme/plans?archives=1'} className="text-blue-800 underline">
            {includeArchived ? 'Masquer les versions archivées' : 'Afficher les versions archivées'}
          </Link>
        </p>
        {plans.length === 0 ? (
          <p className="text-slate-700">Aucun plan.</p>
        ) : (
          <DataTable
            caption="Plans"
            columns={[{ header: 'Plan' }, { header: 'Version' }, { header: 'Prix mensuel', align: 'right' }, { header: 'Prix annuel', align: 'right' }, { header: 'Limites (util. / sites / RDV)' }, { header: 'État' }, ...(canWrite ? [{ header: 'Action' }] : [])]}
          >
            {plans.map((plan) => (
              <tr key={plan.id || `${plan.code}-${String(plan.version)}`}>
                <Cell><span className="font-semibold">{plan.name}</span><span className="block font-mono text-xs text-slate-700">{plan.code}</span></Cell>
                <Cell>v{plan.version}</Cell>
                <Cell align="right">{formatMoney(plan.priceMonthly, plan.currency)}</Cell>
                <Cell align="right">{formatMoney(plan.priceYearly, plan.currency)}</Cell>
                <Cell>{limit(plan.entitlements.limits.users)} / {limit(plan.entitlements.limits.sites)} / {limit(plan.entitlements.limits.appointmentsMonthly)}</Cell>
                <Cell>
                  {plan.archivedAt ? <Badge tone="neutral">Archivée</Badge> : <Badge tone="success">En vigueur</Badge>}{' '}
                  {plan.isPublic ? null : <Badge tone="warning">Non publique</Badge>}
                </Cell>
                {canWrite ? (
                  <Cell>
                    {plan.archivedAt ? <span className="text-slate-600">-</span> : (
                      <Link href={`/plateforme/plans?base=${encodeURIComponent(plan.code)}${includeArchived ? '&archives=1' : ''}#nouvelle-version`} className="font-semibold text-blue-800 underline">Nouvelle version</Link>
                    )}
                  </Cell>
                ) : null}
              </tr>
            ))}
          </DataTable>
        )}
        {canWrite ? (
          <section id="nouvelle-version" aria-labelledby="titre-version" className="rounded-md border border-slate-300 bg-white p-4">
            <h2 id="titre-version" className="mb-3 text-lg font-semibold">{base ? `Nouvelle version de « ${base.name} »` : 'Créer un plan'}</h2>
            <PlanVersionForm key={base?.id ?? 'new'} base={base} />
          </section>
        ) : null}
      </div>
    </>
  );
}
