import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { changeTenantPlanAction, extendTrialAction } from '@/actions/platform-console';
import { ActionForm } from '@/components/forms/ActionForm';
import { UsagePanel } from '@/components/subscription/UsagePanel';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { settle } from '@/lib/api/settle';
import { hasPlatformPermission } from '@/lib/auth/platform-me';
import { formatMoney } from '@/lib/domain/money';
import { toPlatformPlan, toPlatformSubscription } from '@/lib/domain/platform';
import { isUuid, items } from '@/lib/domain/raw';
import { PERIOD_LABELS, STATUS_LABELS, statusTone, usageRows } from '@/lib/domain/subscription';
import { formatDay } from '@/lib/format/dates';
import { platformPageApi } from '@/server/platform-api';
import { requirePlatformMe } from '@/server/platform-me';

export const metadata: Metadata = { title: 'Abonnement' };

export default async function TenantSubscriptionPage({ params }: { readonly params: Promise<{ tenantId: string }> }) {
  const me = await requirePlatformMe();
  if (!hasPlatformPermission(me, 'subscriptions:read')) return <AccessDenied what="les abonnements" />;
  const { tenantId } = await params;
  if (!isUuid(tenantId)) notFound();
  const canWrite = hasPlatformPermission(me, 'subscriptions:write');

  const [subResult, plansResult] = await Promise.all([
    settle(() => platformPageApi(`/platform/subscriptions/${tenantId}`)),
    canWrite && hasPlatformPermission(me, 'plans:read') ? settle(() => platformPageApi('/platform/plans')) : Promise.resolve(null),
  ]);
  if (!subResult.ok) {
    if (subResult.status === 404) notFound();
    return <Alert tone="error">{subResult.message}</Alert>;
  }
  const subscription = toPlatformSubscription(subResult.value.data);
  if (!subscription) return <Alert tone="info">Cet établissement n&apos;a pas d&apos;abonnement.</Alert>;
  const plans = plansResult?.ok ? items(plansResult.value.data, toPlatformPlan).filter((plan) => plan.archivedAt === null) : [];

  return (
    <>
      <PageHeader title="Abonnement de l'établissement" description={subscription.plan.name} />
      <div className="space-y-8">
        <dl className="grid gap-3 rounded-md border border-slate-300 bg-white p-4 sm:grid-cols-4">
          <div><dt className="text-sm text-slate-700">Statut</dt><dd><Badge tone={statusTone(subscription.status)}>{STATUS_LABELS[subscription.status]}</Badge></dd></div>
          <div><dt className="text-sm text-slate-700">Périodicité</dt><dd className="font-medium">{PERIOD_LABELS[subscription.billingPeriod]}</dd></div>
          <div><dt className="text-sm text-slate-700">Période en cours</dt><dd className="font-medium">{formatDay(subscription.currentPeriodStart, 'UTC')} au {formatDay(subscription.currentPeriodEnd, 'UTC')}</dd></div>
          <div><dt className="text-sm text-slate-700">Prix du plan</dt><dd className="font-medium">{formatMoney(subscription.billingPeriod === 'yearly' ? subscription.plan.priceYearly : subscription.plan.priceMonthly, subscription.plan.currency)}</dd></div>
        </dl>
        {subscription.suspensionReason ? <Alert tone="error">Motif de suspension : {subscription.suspensionReason}</Alert> : null}
        {subscription.trialEndsAt ? <p className="text-slate-800">Fin d&apos;essai : {formatDay(subscription.trialEndsAt, 'UTC')}{subscription.trialExtended ? ' (déjà prolongé)' : ''}</p> : null}

        <section aria-labelledby="usage">
          <h2 id="usage" className="mb-3 text-lg font-semibold">Usage</h2>
          <div className="rounded-md border border-slate-300 bg-white p-4"><UsagePanel rows={usageRows(subscription)} /></div>
        </section>

        {canWrite ? (
          <div className="grid gap-6 md:grid-cols-2">
            <section aria-labelledby="changer-plan" className="rounded-md border border-slate-300 bg-white p-4">
              <h2 id="changer-plan" className="mb-3 text-lg font-semibold">Changer de plan</h2>
              {plans.length === 0 ? (
                <p className="text-slate-700">La liste des plans est indisponible.</p>
              ) : (
                <ActionForm
                  action={changeTenantPlanAction}
                  idPrefix="change-"
                  hidden={{ tenantId: subscription.tenantId || tenantId }}
                  fields={[
                    { kind: 'select', name: 'planCode', label: 'Plan', required: true, defaultValue: subscription.plan.code, options: plans.map((plan) => ({ value: plan.code, label: `${plan.name}${plan.isPublic ? '' : ' (non public)'}` })) },
                    { kind: 'select', name: 'billingPeriod', label: 'Périodicité', defaultValue: subscription.billingPeriod, options: [{ value: 'monthly', label: PERIOD_LABELS.monthly }, { value: 'yearly', label: PERIOD_LABELS.yearly }] },
                  ]}
                  submitLabel="Appliquer le changement"
                  pendingLabel="Changement…"
                />
              )}
            </section>
            <section aria-labelledby="essai" className="rounded-md border border-slate-300 bg-white p-4">
              <h2 id="essai" className="mb-3 text-lg font-semibold">Essai gratuit</h2>
              {subscription.status === 'trial' && !subscription.trialExtended ? (
                <>
                  <p className="mb-3 text-sm text-slate-800">Prolonge l&apos;essai de 15 jours, une seule fois.</p>
                  <ActionForm action={extendTrialAction} idPrefix="trial-" hidden={{ tenantId: subscription.tenantId || tenantId }} fields={[]} submitLabel="Prolonger l'essai de 15 jours" pendingLabel="Prolongation…" />
                </>
              ) : (
                <p className="text-slate-700">{subscription.status === 'trial' ? 'L\'essai a déjà été prolongé.' : 'L\'établissement n\'est pas en période d\'essai.'}</p>
              )}
            </section>
          </div>
        ) : null}
        <p><Link href={`/plateforme/etablissements/${encodeURIComponent(tenantId)}`} className="text-blue-800 underline">Retour à l&apos;établissement</Link></p>
      </div>
    </>
  );
}
