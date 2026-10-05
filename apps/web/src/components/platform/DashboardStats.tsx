import type { PlatformDashboard } from '@ghmt/shared';
import { moneyByCurrency } from '@/lib/domain/platform';

function Stat({ label, value, tone = 'default' }: { readonly label: string; readonly value: string; readonly tone?: 'default' | 'alert' }) {
  return (
    <div className="rounded-md border border-slate-300 bg-white p-4">
      <dt className="text-sm text-slate-700">{label}</dt>
      <dd className={`mt-1 text-2xl font-bold tabular-nums ${tone === 'alert' ? 'text-red-800' : 'text-slate-900'}`}>{value}</dd>
    </div>
  );
}

const NUMBER = new Intl.NumberFormat('fr-FR');

export function DashboardStats({ dashboard }: { readonly dashboard: PlatformDashboard }) {
  const n = (value: number): string => NUMBER.format(value).replace(/ /g, ' ');
  return (
    <div className="space-y-6">
      <section aria-labelledby="etablissements">
        <h2 id="etablissements" className="mb-3 text-lg font-semibold">Établissements</h2>
        <dl className="grid gap-3 sm:grid-cols-4">
          <Stat label="Total" value={n(dashboard.tenants.total)} />
          <Stat label="Actifs" value={n(dashboard.tenants.active)} />
          <Stat label="En essai" value={n(dashboard.tenants.trial)} />
          <Stat label="Suspendus" value={n(dashboard.tenants.suspended)} tone={dashboard.tenants.suspended > 0 ? 'alert' : 'default'} />
        </dl>
      </section>
      <section aria-labelledby="activite">
        <h2 id="activite" className="mb-3 text-lg font-semibold">Activité (comptes agrégés)</h2>
        <dl className="grid gap-3 sm:grid-cols-3">
          <Stat label="Utilisateurs" value={n(dashboard.users)} />
          <Stat label="Patients" value={n(dashboard.patients)} />
          <Stat label="Rendez-vous (30 jours)" value={n(dashboard.appointmentsLast30Days)} />
        </dl>
      </section>
      <section aria-labelledby="revenus">
        <h2 id="revenus" className="mb-3 text-lg font-semibold">Revenus récurrents</h2>
        <dl className="grid gap-3 sm:grid-cols-3">
          <Stat label="MRR (mensuel)" value={moneyByCurrency(dashboard.mrr)} />
          <Stat label="ARR (annuel)" value={moneyByCurrency(dashboard.arr)} />
          <Stat label="Factures en retard" value={n(dashboard.overdueInvoices)} tone={dashboard.overdueInvoices > 0 ? 'alert' : 'default'} />
        </dl>
      </section>
    </div>
  );
}
