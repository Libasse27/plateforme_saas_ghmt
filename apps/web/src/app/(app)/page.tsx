import type { Metadata } from 'next';
import Link from 'next/link';
import { Alert } from '@/components/ui/Alert';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { buttonClass } from '@/components/ui/styles';
import { isApiError } from '@/lib/api/errors';
import { describeApiError } from '@/lib/api/messages';
import { canUse } from '@/lib/auth/me';
import { ACTIVE_STATUSES } from '@/lib/domain/appointments';
import { toAppointment, toList } from '@/lib/domain/mappers';
import { dayRange, formatLongDay, formatTime, todayInZone } from '@/lib/format/dates';
import { pageApi } from '@/server/api';
import { requireMe } from '@/server/me';

export const metadata: Metadata = { title: 'Tableau de bord' };

const MAX_TODAY = 200;

async function loadToday(timezone: string) {
  const day = todayInZone(timezone);
  const { from, to } = dayRange(day, timezone);
  try {
    const { data } = await pageApi('/appointments', { query: { from, to, limit: MAX_TODAY } });
    return { day, appointments: toList(data, toAppointment), error: null };
  } catch (error) {
    if (!isApiError(error)) throw error;
    return { day, appointments: [], error: describeApiError(error) };
  }
}

export default async function DashboardPage() {
  const me = await requireMe();
  const canSeeAgenda = canUse(me, 'appointments', 'appointments:appointment:read');
  const canCreatePatient = canUse(me, 'patients', 'patients:patient:create');
  const canSearchPatient = canUse(me, 'patients', 'patients:patient:read');
  const today = canSeeAgenda ? await loadToday(me.tenant.timezone) : null;
  const active = today?.appointments.filter((a) => ACTIVE_STATUSES.includes(a.status)).length ?? 0;

  return (
    <>
      <PageHeader title={`Bonjour, ${me.user.fullName}`} description={today ? formatLongDay(today.day) : me.tenant.name} />

      <section aria-labelledby="acces-rapides" className="mb-8">
        <h2 id="acces-rapides" className="mb-3 text-lg font-semibold">Accès rapides</h2>
        <div className="flex flex-wrap gap-3">
          {canSearchPatient ? <Link href="/patients" className={buttonClass.secondary}>Rechercher un patient</Link> : null}
          {canCreatePatient ? <Link href="/patients/nouveau" className={buttonClass.primary}>Nouveau patient</Link> : null}
          {canSeeAgenda ? <Link href="/rendez-vous" className={buttonClass.secondary}>Agenda du jour</Link> : null}
          {!canSearchPatient && !canCreatePatient && !canSeeAgenda ? <p className="text-slate-700">Aucun module disponible pour votre profil.</p> : null}
        </div>
      </section>

      {today ? (
        <section aria-labelledby="rdv-jour">
          <h2 id="rdv-jour" className="mb-3 text-lg font-semibold">Rendez-vous du jour ({active} actif{active > 1 ? 's' : ''})</h2>
          {today.error ? <Alert tone="error">{today.error}</Alert> : null}
          {!today.error && today.appointments.length === 0 ? <p className="text-slate-700">Aucun rendez-vous aujourd&apos;hui.</p> : null}
          {today.appointments.length > 0 ? (
            <div className="overflow-x-auto rounded-md border border-slate-300 bg-white">
              <table className="w-full text-left text-sm">
                <caption className="sr-only">Rendez-vous du jour</caption>
                <thead className="bg-slate-100">
                  <tr>
                    <th scope="col" className="px-3 py-2">Heure</th>
                    <th scope="col" className="px-3 py-2">Patient</th>
                    <th scope="col" className="px-3 py-2">Praticien</th>
                    <th scope="col" className="px-3 py-2">Statut</th>
                  </tr>
                </thead>
                <tbody>
                  {[...today.appointments].sort((a, b) => a.startsAt.localeCompare(b.startsAt)).map((a) => (
                    <tr key={a.id} className="border-t border-slate-200">
                      <td className="px-3 py-2">{formatTime(a.startsAt, me.tenant.timezone)}</td>
                      <td className="px-3 py-2">{a.patientName}</td>
                      <td className="px-3 py-2">{a.practitionerName}</td>
                      <td className="px-3 py-2"><StatusBadge status={a.status} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
