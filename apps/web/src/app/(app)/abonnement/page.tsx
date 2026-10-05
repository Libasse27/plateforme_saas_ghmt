import type { Metadata } from 'next';
import { cancelSubscriptionAction, resumeSubscriptionAction } from '@/actions/subscription';
import { ActionForm } from '@/components/forms/ActionForm';
import { PlanOffers } from '@/components/subscription/PlanOffers';
import { SaasInvoicesTable } from '@/components/subscription/SaasInvoicesTable';
import { UsagePanel } from '@/components/subscription/UsagePanel';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { settle } from '@/lib/api/settle';
import { hasPermission } from '@/lib/auth/me';
import { formatMoney } from '@/lib/domain/money';
import { items } from '@/lib/domain/raw';
import { PERIOD_LABELS, STATUS_LABELS, subscriptionBanner, statusTone, subscriptionHeadline, toPublicPlan, toSaasInvoice, usageRows } from '@/lib/domain/subscription';
import { formatDay } from '@/lib/format/dates';
import { pageApi } from '@/server/api';
import { requireMe } from '@/server/me';
import { getSubscription } from '@/server/subscription';

export const metadata: Metadata = { title: 'Abonnement' };

const INVOICE_PAGE_SIZE = 20;

export default async function SubscriptionPage() {
  const me = await requireMe();
  if (!hasPermission(me, 'settings:establishment:read')) return <AccessDenied what="l'abonnement" />;
  const canUpdate = hasPermission(me, 'settings:establishment:update');
  const tz = me.tenant.timezone;

  const subscription = await getSubscription(true);
  const [plansResult, invoicesResult] = await Promise.all([
    settle(() => pageApi('/subscription/plans')),
    settle(() => pageApi('/subscription/invoices', { query: { limit: INVOICE_PAGE_SIZE } })),
  ]);
  const plans = plansResult.ok ? items(plansResult.value.data, toPublicPlan) : [];
  const invoices = invoicesResult.ok ? items(invoicesResult.value.data, toSaasInvoice) : [];
  const hasMoreInvoices = invoicesResult.ok && invoicesResult.value.meta.pagination?.hasMore === true;

  if (!subscription) {
    return (
      <>
        <PageHeader title="Abonnement" />
        <Alert tone="info">Aucun abonnement n&apos;est rattaché à votre établissement : aucune limite de plan ne s&apos;applique.</Alert>
      </>
    );
  }

  const banner = subscriptionBanner(subscription.status);
  const price = subscription.billingPeriod === 'yearly' ? subscription.plan.priceYearly : subscription.plan.priceMonthly;

  return (
    <>
      <PageHeader title="Abonnement" description={me.tenant.name} />
      <div className="space-y-8">
        <Alert tone={banner?.tone ?? 'info'}>{subscriptionHeadline(subscription, new Date(), tz)}</Alert>

        <section aria-labelledby="plan-courant" className="rounded-md border border-slate-300 bg-white p-4">
          <h2 id="plan-courant" className="mb-3 text-lg font-semibold">Plan courant</h2>
          <dl className="grid gap-3 sm:grid-cols-2">
            <div><dt className="text-sm text-slate-700">Plan</dt><dd className="font-medium">{subscription.plan.name}</dd></div>
            <div><dt className="text-sm text-slate-700">Statut</dt><dd><Badge tone={statusTone(subscription.status)}>{STATUS_LABELS[subscription.status]}</Badge></dd></div>
            <div><dt className="text-sm text-slate-700">Périodicité</dt><dd className="font-medium">{PERIOD_LABELS[subscription.billingPeriod]} · {formatMoney(price, subscription.plan.currency)}</dd></div>
            <div><dt className="text-sm text-slate-700">Période en cours</dt><dd className="font-medium">{formatDay(subscription.currentPeriodStart, tz)} au {formatDay(subscription.currentPeriodEnd, tz)}</dd></div>
          </dl>
          {subscription.pendingChange ? (
            <p className="mt-3 text-sm text-slate-800">
              Changement programmé : plan « {subscription.pendingChange.planCode} » ({PERIOD_LABELS[subscription.pendingChange.billingPeriod].toLowerCase()}) à partir du {formatDay(subscription.pendingChange.effectiveAt, tz)}.
            </p>
          ) : null}
          {canUpdate && subscription.status === 'active' ? (
            <div className="mt-4 border-t border-slate-200 pt-4">
              {subscription.cancelAtPeriodEnd ? (
                <ActionForm action={resumeSubscriptionAction} fields={[]} submitLabel="Reprendre l'abonnement" pendingLabel="Reprise…" idPrefix="resume-" />
              ) : (
                <details>
                  <summary className="cursor-pointer font-semibold text-red-800">Résilier l&apos;abonnement</summary>
                  <div className="mt-2 space-y-2">
                    <p className="text-sm text-slate-800">La résiliation prend effet à la fin de la période en cours ({formatDay(subscription.currentPeriodEnd, tz)}). Vous pouvez la reprendre avant cette date.</p>
                    <ActionForm action={cancelSubscriptionAction} fields={[]} submitLabel="Confirmer la résiliation" variant="danger" pendingLabel="Résiliation…" idPrefix="cancel-" />
                  </div>
                </details>
              )}
            </div>
          ) : null}
        </section>

        <section aria-labelledby="usage">
          <h2 id="usage" className="mb-3 text-lg font-semibold">Usage du mois</h2>
          <div className="rounded-md border border-slate-300 bg-white p-4"><UsagePanel rows={usageRows(subscription)} /></div>
        </section>

        <section aria-labelledby="offres">
          <h2 id="offres" className="mb-3 text-lg font-semibold">Offres et changement de plan</h2>
          {plansResult.ok ? <PlanOffers plans={plans} current={subscription} canUpdate={canUpdate} /> : <Alert tone="error">{plansResult.message}</Alert>}
        </section>

        <section aria-labelledby="factures">
          <h2 id="factures" className="mb-3 text-lg font-semibold">Factures d&apos;abonnement</h2>
          {invoicesResult.ok ? <SaasInvoicesTable invoices={invoices} canPay={canUpdate} timeZone={tz} /> : <Alert tone="error">{invoicesResult.message}</Alert>}
          {hasMoreInvoices ? <p className="mt-2 text-sm text-slate-700">Seules les {INVOICE_PAGE_SIZE} factures les plus récentes sont affichées.</p> : null}
        </section>
      </div>
    </>
  );
}
