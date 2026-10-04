import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Alert } from '@/components/ui/Alert';
import { PageHeader } from '@/components/ui/PageHeader';
import { buttonClass } from '@/components/ui/styles';
import { isApiError } from '@/lib/api/errors';
import { describeApiError } from '@/lib/api/messages';
import { canUse } from '@/lib/auth/me';
import { toPatient } from '@/lib/domain/mappers';
import { deceasedBanner, patientSheetRows } from '@/lib/domain/patient-sheet';
import { pageApi } from '@/server/api';
import { requireMe } from '@/server/me';

export const metadata: Metadata = { title: 'Fiche patient' };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function PatientPage({ params }: { readonly params: Promise<{ id: string }> }) {
  const me = await requireMe();
  if (!canUse(me, 'patients', 'patients:patient:read')) return <AccessDenied what="les fiches patients" />;

  const { id } = await params;
  if (!UUID_PATTERN.test(id)) notFound();

  let patientRaw: unknown;
  try {
    patientRaw = (await pageApi(`/patients/${id}`)).data;
  } catch (error) {
    if (isApiError(error) && error.status === 404) notFound();
    if (!isApiError(error)) throw error;
    return <Alert tone="error">{describeApiError(error)}</Alert>;
  }

  const patient = toPatient(patientRaw);
  const canBook = canUse(me, 'appointments', 'appointments:appointment:create');
  const rows = patientSheetRows(patient);
  const banner = deceasedBanner(patient);

  return (
    <>
      <PageHeader
        title={patient.fullName}
        actions={
          canBook && !banner ? (
            <Link href={`/rendez-vous?patientId=${encodeURIComponent(patient.id)}${patient.recordNumber ? `&ipp=${encodeURIComponent(patient.recordNumber)}` : ''}&nouveau=1`} className={buttonClass.primary}>Prendre un rendez-vous</Link>
          ) : undefined
        }
      />
      {banner ? <Alert tone="error">{banner}</Alert> : null}
      <dl className="grid gap-x-6 gap-y-3 rounded-md border border-slate-300 bg-white p-4 sm:grid-cols-2">
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt className="text-sm text-slate-700">{label}</dt>
            <dd className="font-medium">{value || '-'}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4"><Link href="/patients" className="text-blue-800 underline">Retour à la liste</Link></p>
    </>
  );
}
