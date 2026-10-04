import type { Metadata } from 'next';
import Link from 'next/link';
import { AppointmentBooking } from '@/components/forms/AppointmentBooking';
import { StatusActions } from '@/components/forms/StatusActions';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Alert } from '@/components/ui/Alert';
import { PageHeader } from '@/components/ui/PageHeader';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { buttonClass, inputClass } from '@/components/ui/styles';
import { isApiError } from '@/lib/api/errors';
import { describeApiError } from '@/lib/api/messages';
import { canUse } from '@/lib/auth/me';
import { agendaHref } from '@/lib/domain/agenda-links';
import { allowedStatusActions } from '@/lib/domain/appointments';
import { loadBookingPatient, type BookingPatient } from '@/lib/domain/booking-patient';
import { groupByPractitioner, toAppointment, toList, toPractitioner, toSite } from '@/lib/domain/mappers';
import { addDays, dayRange, formatLongDay, formatTime, isDayString, todayInZone } from '@/lib/format/dates';
import { pageApi } from '@/server/api';
import { requireMe } from '@/server/me';

export const metadata: Metadata = { title: 'Rendez-vous' };

const MAX_APPOINTMENTS = 200;

interface Search {
  date?: string;
  practitionerId?: string;
  patientId?: string;
  ipp?: string;
  nouveau?: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AppointmentsPage({ searchParams }: { readonly searchParams: Promise<Search> }) {
  const me = await requireMe();
  if (!canUse(me, 'appointments', 'appointments:appointment:read')) return <AccessDenied what="l'agenda" />;

  const search = await searchParams;
  const tz = me.tenant.timezone;
  const day = isDayString(search.date) ? search.date : todayInZone(tz);
  const practitionerId = search.practitionerId && UUID_PATTERN.test(search.practitionerId) ? search.practitionerId : undefined;
  const canCreate = canUse(me, 'appointments', 'appointments:appointment:create');
  const canUpdate = canUse(me, 'appointments', 'appointments:appointment:update');
  const canListPractitioners = canUse(me, 'appointments', 'appointments:agenda:read');
  const showCreate = canCreate && search.nouveau === '1';
  const { from, to } = dayRange(day, tz);

  let error: string | null = null;
  let practitioners: ReturnType<typeof toPractitioner>[] = [];
  let appointments: ReturnType<typeof toAppointment>[] = [];
  let truncated = false;
  try {
    const [practitionersRes, appointmentsRes] = await Promise.all([
      canListPractitioners ? pageApi('/practitioners') : Promise.resolve(null),
      pageApi('/appointments', { query: { from, to, practitionerId, limit: MAX_APPOINTMENTS } }),
    ]);
    practitioners = practitionersRes ? toList(practitionersRes.data, toPractitioner) : [];
    appointments = toList(appointmentsRes.data, toAppointment);
    truncated = appointmentsRes.meta.pagination?.hasMore === true;
  } catch (caught) {
    if (!isApiError(caught)) throw caught;
    error = describeApiError(caught);
  }

  const visiblePractitioners = practitionerId ? practitioners.filter((p) => p.id === practitionerId) : practitioners;
  const groups = groupByPractitioner(appointments, visiblePractitioners);
  const base = { date: day, practitionerId };

  return (
    <>
      <PageHeader
        title="Rendez-vous"
        description={formatLongDay(day)}
        actions={canCreate && !showCreate ? <Link href={agendaHref({ ...base, nouveau: true })} className={buttonClass.primary}>Nouveau rendez-vous</Link> : undefined}
      />

      <nav aria-label="Navigation par jour" className="mb-4 flex flex-wrap items-end gap-2">
        <Link href={agendaHref({ ...base, date: addDays(day, -1) })} className={buttonClass.secondary}>Jour précédent</Link>
        <Link href={agendaHref({ practitionerId })} className={buttonClass.secondary}>Aujourd&apos;hui</Link>
        <Link href={agendaHref({ ...base, date: addDays(day, 1) })} className={buttonClass.secondary}>Jour suivant</Link>
      </nav>
      <form method="get" className="mb-6 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="date" className="mb-1 block text-sm font-medium">Date</label>
          <input id="date" name="date" type="date" defaultValue={day} className={inputClass} />
        </div>
        {canListPractitioners ? (
          <div>
            <label htmlFor="practitionerId" className="mb-1 block text-sm font-medium">Praticien</label>
            <select id="practitionerId" name="practitionerId" defaultValue={practitionerId ?? ''} className={inputClass}>
              <option value="">Tous</option>
              {practitioners.map((p) => (
                <option key={p.id} value={p.id}>{p.fullName}</option>
              ))}
            </select>
          </div>
        ) : null}
        <button type="submit" className={buttonClass.primary}>Afficher</button>
      </form>

      {error ? <Alert tone="error">{error}</Alert> : null}
      {truncated ? (
        <Alert tone="warning">Seuls les {MAX_APPOINTMENTS} premiers rendez-vous sont affichés. Filtrez par praticien pour voir les autres.</Alert>
      ) : null}

      {showCreate ? (
        <section aria-labelledby="creation" className="mb-8 rounded-md border border-slate-300 bg-white p-4">
          <h2 id="creation" className="mb-3 text-lg font-semibold">Nouveau rendez-vous</h2>
          <CreationPanel patientId={search.patientId} ipp={search.ipp} practitioners={practitioners} canSearchPatients={canUse(me, 'patients', 'patients:patient:read')} day={day} />
        </section>
      ) : null}

      {!error && groups.every((g) => g.appointments.length === 0) ? <p className="text-slate-700">Aucun rendez-vous ce jour.</p> : null}

      {groups.filter((g) => g.appointments.length > 0).map(({ practitioner, appointments: list }) => (
        <section key={practitioner.id} aria-labelledby={`prat-${practitioner.id}`} className="mb-6">
          <h2 id={`prat-${practitioner.id}`} className="mb-2 text-lg font-semibold">
            {practitioner.fullName}
            {practitioner.specialty ? <span className="ml-2 text-sm font-normal text-slate-700">{practitioner.specialty}</span> : null}
          </h2>
          <ul className="space-y-2">
            {list.map((a) => (
              <li key={a.id} className="rounded-md border border-slate-300 bg-white p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-medium">
                    {formatTime(a.startsAt, tz)} - {formatTime(a.endsAt, tz)} · {a.patientId ? <Link href={`/patients/${encodeURIComponent(a.patientId)}`} className="text-blue-800 underline">{a.patientName}</Link> : a.patientName}
                    {a.patientDeceasedAt ? <span className="ml-2 rounded bg-slate-800 px-2 py-0.5 text-xs font-semibold text-white">Décédé</span> : null}
                    <span className="ml-2 text-sm font-normal text-slate-700">
                      {[a.patientIpp, a.patientBirthYear ? `né(e) en ${String(a.patientBirthYear)}` : ''].filter(Boolean).join(' · ')}
                    </span>
                  </p>
                  <StatusBadge status={a.status} />
                </div>
                {a.reason ? <p className="mt-1 text-sm text-slate-700">{a.reason}</p> : null}
                {canUpdate ? <div className="mt-2"><StatusActions appointmentId={a.id} actions={allowedStatusActions(a.status)} /></div> : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

interface CreationPanelProps {
  readonly patientId: string | undefined;
  readonly ipp: string | undefined;
  readonly practitioners: readonly ReturnType<typeof toPractitioner>[];
  readonly canSearchPatients: boolean;
  readonly day: string;
}

async function CreationPanel({ patientId: rawPatientId, ipp, practitioners, canSearchPatients, day }: CreationPanelProps) {
  const patientId = rawPatientId && UUID_PATTERN.test(rawPatientId) ? rawPatientId : undefined;
  if (!patientId && !canSearchPatients) return <AccessDenied what="la recherche de patients" />;
  if (practitioners.length === 0) return <Alert tone="warning">La liste des praticiens est indisponible : vous ne pouvez pas planifier de rendez-vous.</Alert>;

  let loaded: { patient: BookingPatient | null; sites: { value: string; label: string }[] };
  try {
    const search = async (body: { readonly ipp: string; readonly limit: number }): Promise<unknown> =>
      (await pageApi('/patients/search', { method: 'POST', body })).data;
    const [patient, sitesRes] = await Promise.all([patientId ? loadBookingPatient(search, patientId, ipp) : Promise.resolve(null), pageApi('/org/sites')]);
    loaded = {
      patient,
      sites: toList(sitesRes.data, toSite).map((s) => ({ value: s.id, label: s.city ? `${s.name} (${s.city})` : s.name })),
    };
  } catch (caught) {
    if (!isApiError(caught)) throw caught;
    return <Alert tone="error">{describeApiError(caught)}</Alert>;
  }

  return (
    <AppointmentBooking
      initialPatient={loaded.patient ? { id: loaded.patient.id, fullName: loaded.patient.fullName } : undefined}
      practitioners={practitioners.map((p) => ({ value: p.id, label: p.specialty ? `${p.fullName} - ${p.specialty}` : p.fullName }))}
      sites={loaded.sites}
      date={day}
    />
  );
}
