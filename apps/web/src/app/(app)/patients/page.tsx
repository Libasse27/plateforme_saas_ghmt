import type { Metadata } from 'next';
import Link from 'next/link';
import { PatientSearch } from '@/components/forms/PatientSearch';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { PageHeader } from '@/components/ui/PageHeader';
import { buttonClass } from '@/components/ui/styles';
import { canUse } from '@/lib/auth/me';
import { requireMe } from '@/server/me';

export const metadata: Metadata = { title: 'Patients' };

/** Aucune liste exhaustive : la recherche passe par une Server Action (POST), sans terme dans l'URL. */
export default async function PatientsPage() {
  const me = await requireMe();
  if (!canUse(me, 'patients', 'patients:patient:read')) return <AccessDenied what="la recherche de patients" />;
  const canCreate = canUse(me, 'patients', 'patients:patient:create');

  return (
    <>
      <PageHeader
        title="Patients"
        actions={canCreate ? <Link href="/patients/nouveau" className={buttonClass.primary}>Nouveau patient</Link> : undefined}
      />
      <PatientSearch />
    </>
  );
}
