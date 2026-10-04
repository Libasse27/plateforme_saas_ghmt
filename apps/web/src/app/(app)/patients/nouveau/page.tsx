import type { Metadata } from 'next';
import { BLOOD_GROUPS, SEXES } from '@ghmt/shared';
import { PatientForm } from '@/components/forms/PatientForm';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { PageHeader } from '@/components/ui/PageHeader';
import { canUse } from '@/lib/auth/me';
import { SEX_LABELS } from '@/lib/domain/labels';
import { requireMe } from '@/server/me';

export const metadata: Metadata = { title: 'Nouveau patient' };

const SEX_OPTIONS = SEXES.map((value) => ({ value, label: SEX_LABELS[value] ?? value }));
const BLOOD_GROUP_OPTIONS = BLOOD_GROUPS.map((value) => ({ value, label: value }));

export default async function NewPatientPage() {
  const me = await requireMe();
  if (!canUse(me, 'patients', 'patients:patient:create')) return <AccessDenied what="la création de patients" />;
  return (
    <>
      <PageHeader title="Nouveau patient" description="Les champs marqués d'une étoile sont obligatoires." />
      <PatientForm sexOptions={SEX_OPTIONS} bloodGroupOptions={BLOOD_GROUP_OPTIONS} />
    </>
  );
}
