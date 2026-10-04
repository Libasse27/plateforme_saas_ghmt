import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { reactivateTenantAction, suspendTenantAction } from '@/actions/platform-console';
import { ActionForm } from '@/components/forms/ActionForm';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { settle } from '@/lib/api/settle';
import { hasPlatformPermission } from '@/lib/auth/platform-me';
import { TENANT_STATUS_LABELS, toTenantDetail } from '@/lib/domain/platform';
import { isUuid } from '@/lib/domain/raw';
import { PERIOD_LABELS, STATUS_LABELS } from '@/lib/domain/subscription';
import { formatDay } from '@/lib/format/dates';
import { platformPageApi } from '@/server/platform-api';
import { requirePlatformMe } from '@/server/platform-me';

export const metadata: Metadata = { title: 'Établissement' };

export default async function TenantDetailPage({ params }: { readonly params: Promise<{ id: string }> }) {
  const me = await requirePlatformMe();
  if (!hasPlatformPermission(me, 'tenants:read')) return <AccessDenied what="les établissements" />;
  const { id } = await params;
  if (!isUuid(id)) notFound();

  const result = await settle(() => platformPageApi(`/platform/tenants/${id}`));
  if (!result.ok) {
    if (result.status === 404) notFound();
    return <Alert tone="error">{result.message}</Alert>;
  }
  const { tenant, subscription, usage, modules, invoices } = toTenantDetail(result.value.data);
  const canSuspend = hasPlatformPermission(me, 'tenants:suspend');
  const suspended = tenant.status === 'suspended';

  return (
    <>
      <PageHeader title={tenant.name} description={`${tenant.slug} · ${tenant.legalName}`} />
      <div className="space-y-8">
        <dl className="grid gap-3 rounded-md border border-slate-300 bg-white p-4 sm:grid-cols-4">
          <div><dt className="text-sm text-slate-700">Statut</dt><dd><Badge tone={suspended ? 'danger' : tenant.status === 'active' ? 'success' : 'neutral'}>{TENANT_STATUS_LABELS[tenant.status] ?? tenant.status}</Badge></dd></div>
          <div><dt className="text-sm text-slate-700">Pays</dt><dd className="font-medium">{tenant.countryCode}</dd></div>
          <div><dt className="text-sm text-slate-700">Devise</dt><dd className="font-medium">{tenant.baseCurrency}</dd></div>
          <div><dt className="text-sm text-slate-700">Créé le</dt><dd className="font-medium">{formatDay(tenant.createdAt, 'UTC')}</dd></div>
        </dl>
        {tenant.suspensionReason ? <Alert tone="error">Motif de suspension : {tenant.suspensionReason}</Alert> : null}

        <section aria-labelledby="usage">
          <h2 id="usage" className="mb-3 text-lg font-semibold">Usage (comptes agrégés)</h2>
          <dl className="grid gap-3 sm:grid-cols-5">
            {[
              ['Utilisateurs', usage.users],
              ['Sites', usage.sites],
              ['Patients', usage.patients],
              ['RDV du mois', usage.appointmentsThisMonth],
              ['RDV (30 jours)', usage.appointmentsLast30Days],
            ].map(([label, value]) => (
              <div key={label} className="rounded-md border border-slate-300 bg-white p-3">
                <dt className="text-sm text-slate-700">{label}</dt>
                <dd className="text-xl font-bold tabular-nums">{value}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-2 text-sm text-slate-800">Factures SaaS ouvertes : {invoices.open} · en retard : {invoices.overdue}</p>
          {modules.length > 0 ? <p className="mt-1 text-sm text-slate-800">Modules : {modules.join(', ')}</p> : null}
        </section>

        <section aria-labelledby="abonnement" className="rounded-md border border-slate-300 bg-white p-4">
          <h2 id="abonnement" className="mb-2 text-lg font-semibold">Abonnement</h2>
          {subscription ? (
            <p>
              {subscription.plan.name} · {PERIOD_LABELS[subscription.billingPeriod]} · {STATUS_LABELS[subscription.status]} · fin de période le {formatDay(subscription.currentPeriodEnd, 'UTC')}
            </p>
          ) : (
            <p className="text-slate-700">Aucun abonnement.</p>
          )}
          {hasPlatformPermission(me, 'subscriptions:read') ? (
            <p className="mt-2"><Link href={`/plateforme/abonnements/${encodeURIComponent(tenant.id)}`} className="font-semibold text-blue-800 underline">Gérer l&apos;abonnement</Link></p>
          ) : null}
        </section>

        {canSuspend ? (
          <section aria-labelledby="suspension" className="rounded-md border border-slate-300 bg-white p-4">
            <h2 id="suspension" className="mb-3 text-lg font-semibold">{suspended ? 'Réactivation' : 'Suspension'}</h2>
            {suspended ? (
              <ActionForm action={reactivateTenantAction} hidden={{ tenantId: tenant.id }} fields={[]} submitLabel="Réactiver l'établissement" pendingLabel="Réactivation…" idPrefix="reactivate-" />
            ) : (
              <>
                <p className="mb-3 text-sm text-slate-800">La suspension met l&apos;établissement en lecture seule. Le motif est conservé et un paiement ne la lève pas.</p>
                <ActionForm
                  action={suspendTenantAction}
                  hidden={{ tenantId: tenant.id }}
                  fields={[{ kind: 'textarea', name: 'reason', label: 'Motif de la suspension', required: true, hint: '5 à 500 caractères.' }]}
                  submitLabel="Suspendre l'établissement"
                  variant="danger"
                  pendingLabel="Suspension…"
                  idPrefix="suspend-"
                />
              </>
            )}
          </section>
        ) : null}
        <p><Link href="/plateforme/etablissements" className="text-blue-800 underline">Retour à la liste</Link></p>
      </div>
    </>
  );
}
