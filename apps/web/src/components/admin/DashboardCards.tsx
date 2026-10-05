import type { ReactNode } from 'react';
import { PAYMENT_METHOD_LABELS, type DashboardView, type PaymentMethodKey } from '@/lib/domain/admin';
import { APPOINTMENT_STATUS_LABELS } from '@/lib/domain/labels';
import type { DisplayStatus } from '@/lib/domain/appointments';
import { formatMoney } from '@/lib/domain/money';
import { formatDateTime } from '@/lib/format/dates';

function Card({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section aria-label={title} className="rounded-md border border-slate-300 bg-white p-4">
      <h2 className="mb-3 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Pairs({ rows }: { readonly rows: readonly (readonly [string, string])[] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-slate-700">{label}</dt>
          <dd className="text-right font-medium tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function Revenue({ revenue }: { readonly revenue: NonNullable<DashboardView['revenue']> }) {
  const methods = Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethodKey[];
  return (
    <Card title="Recettes du jour">
      <p className="mb-3 text-2xl font-bold">{formatMoney(revenue.total, revenue.currency)}</p>
      <Pairs rows={methods.map((method) => [PAYMENT_METHOD_LABELS[method], formatMoney(revenue.byMethod[method], revenue.currency)] as const)} />
    </Card>
  );
}

function CashSessions({ sessions, timeZone }: { readonly sessions: NonNullable<DashboardView['cashSessions']>; readonly timeZone: string }) {
  return (
    <Card title="Sessions de caisse ouvertes">
      {sessions.items.length === 0 ? (
        <p className="text-slate-700">Aucune session ouverte.</p>
      ) : (
        <ul className="space-y-1">
          {sessions.items.map((session) => (
            <li key={session.id}>Caisse {session.registerCode} : {session.openedBy}, depuis {formatDateTime(session.openedAt, timeZone)}</li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Cartes du tableau de bord : une section `null` (droit ou module manquant) n'est pas affichée. Comptes uniquement, aucun nom de patient. */
export function DashboardCards({ dashboard, timeZone }: { readonly dashboard: DashboardView; readonly timeZone: string }) {
  const { patients, appointments, revenue, cashSessions } = dashboard;
  if (!patients && !appointments && !revenue && !cashSessions) {
    return <p className="text-slate-700">Aucune donnée n&apos;est accessible avec vos droits actuels.</p>;
  }
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {patients ? (
        <Card title="Patients">
          <Pairs rows={[['Dossiers actifs', String(patients.total)], ['Enregistrés aujourd\'hui', String(patients.registeredToday)]]} />
        </Card>
      ) : null}
      {appointments ? (
        <Card title="Rendez-vous du jour">
          <p className="mb-3 text-2xl font-bold">{appointments.total}</p>
          <Pairs rows={Object.entries(appointments.byStatus).map(([status, count]) => [APPOINTMENT_STATUS_LABELS[status as DisplayStatus] ?? status, String(count)] as const)} />
        </Card>
      ) : null}
      {revenue ? <Revenue revenue={revenue} /> : null}
      {cashSessions ? <CashSessions sessions={cashSessions} timeZone={timeZone} /> : null}
    </div>
  );
}
