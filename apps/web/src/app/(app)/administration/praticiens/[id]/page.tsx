import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { PractitionerForm } from '@/components/admin/PractitionerForm';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Alert } from '@/components/ui/Alert';
import { PageHeader } from '@/components/ui/PageHeader';
import { canUse, hasPermission } from '@/lib/auth/me';
import { toDepartment, toPractitionerAdmin, toSiteAdmin } from '@/lib/domain/admin';
import { isUuid } from '@/lib/domain/raw';
import { requireMe } from '@/server/me';
import { loadOne, loadOptional } from '../../_lib/page-data';

export const metadata: Metadata = { title: 'Praticien' };

export default async function PractitionerPage({ params }: { readonly params: Promise<{ id: string }> }) {
  const me = await requireMe();
  if (!canUse(me, 'appointments', 'appointments:agenda:read')) return <AccessDenied what="les praticiens" />;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const [loaded, departments, sites] = await Promise.all([
    loadOne(`/practitioners/${id}`, toPractitionerAdmin),
    loadOptional(hasPermission(me, 'org:service:read'), '/org/departments', toDepartment),
    loadOptional(hasPermission(me, 'org:site:read'), '/org/sites', toSiteAdmin),
  ]);
  if (!loaded.ok) return <Alert tone="error">{loaded.message}</Alert>;
  const practitioner = loaded.value;
  const canUpdate = hasPermission(me, 'appointments:agenda:update');

  return (
    <>
      <PageHeader title={practitioner.fullName} description={practitioner.userId ? 'Lié à un compte utilisateur.' : 'Aucun compte utilisateur lié.'} />
      <div className="max-w-xl space-y-4">
        {canUpdate ? (
          <PractitionerForm practitioner={practitioner} departments={departments} sites={sites} />
        ) : (
          <dl className="grid gap-3 rounded-md border border-slate-300 bg-white p-4 sm:grid-cols-2">
            <div><dt className="text-sm text-slate-700">Spécialité</dt><dd className="font-medium">{practitioner.specialty || '-'}</dd></div>
            <div><dt className="text-sm text-slate-700">Consultation par défaut</dt><dd className="font-medium">{practitioner.defaultConsultMinutes} min</dd></div>
            <div><dt className="text-sm text-slate-700">Réservable</dt><dd className="font-medium">{practitioner.isBookable ? 'Oui' : 'Non'}</dd></div>
          </dl>
        )}
        <p><Link href="/administration/praticiens" className="text-blue-800 underline">Retour aux praticiens</Link></p>
      </div>
    </>
  );
}
