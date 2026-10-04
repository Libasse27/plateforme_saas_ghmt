import type { PublicPlanView, SubscriptionView } from '@ghmt/shared';
import { changePlanAction } from '@/actions/subscription';
import { ActionForm } from '@/components/forms/ActionForm';
import { Badge } from '@/components/ui/Badge';
import { formatMoney } from '@/lib/domain/money';
import { PERIOD_LABELS } from '@/lib/domain/subscription';

function limitText(value: number | null, unit: string): string {
  return value === null ? `${unit} illimités` : `${String(value)} ${unit}`;
}

export interface PlanOffersProps {
  readonly plans: readonly PublicPlanView[];
  readonly current: SubscriptionView | null;
  readonly canUpdate: boolean;
}

export function PlanOffers({ plans, current, canUpdate }: PlanOffersProps) {
  if (plans.length === 0) return <p className="text-slate-700">Aucune offre n&apos;est disponible pour le moment.</p>;
  return (
    <ul className="grid gap-4 md:grid-cols-2">
      {plans.map((plan) => {
        const isCurrent = current?.plan.code === plan.code;
        const { limits } = plan.entitlements;
        return (
          <li key={plan.id || plan.code} className={`rounded-md border bg-white p-4 ${isCurrent ? 'border-blue-700' : 'border-slate-300'}`}>
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-lg font-semibold">{plan.name}</h3>
              {isCurrent ? <Badge tone="info">Plan actuel</Badge> : null}
            </div>
            <p className="mt-1 text-slate-900">
              {formatMoney(plan.priceMonthly, plan.currency)} / mois · {formatMoney(plan.priceYearly, plan.currency)} / an
            </p>
            <ul className="mt-2 list-inside list-disc text-sm text-slate-800">
              <li>{limitText(limits.users, 'utilisateurs')}</li>
              <li>{limitText(limits.sites, 'sites')}</li>
              <li>{limitText(limits.appointmentsMonthly, 'rendez-vous par mois')}</li>
              <li>{plan.entitlements.modules.length} modules inclus</li>
            </ul>
            {canUpdate ? (
              <div className="mt-3 border-t border-slate-200 pt-3">
                <ActionForm
                  action={changePlanAction}
                  idPrefix={`plan-${plan.code}-`}
                  hidden={{ planCode: plan.code }}
                  fields={[
                    {
                      kind: 'select',
                      name: 'billingPeriod',
                      label: 'Périodicité',
                      options: (['monthly', 'yearly'] as const).map((value) => ({ value, label: PERIOD_LABELS[value] })),
                      defaultValue: current?.billingPeriod ?? 'monthly',
                    },
                  ]}
                  submitLabel={isCurrent ? 'Changer la périodicité' : `Choisir ${plan.name}`}
                  pendingLabel="Changement…"
                />
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
