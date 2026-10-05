import type { Metadata } from 'next';
import Link from 'next/link';
import { PractitionerForm } from '@/components/admin/PractitionerForm';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { PageHeader } from '@/components/ui/PageHeader';
import { canUse, hasPermission } from '@/lib/auth/me';
import { toDepartment, toSiteAdmin, toUserSummary } from '@/lib/domain/admin';
import { requireMe } from '@/server/me';
import { loadOptional } from '../../_lib/page-data';

export const metadata: Metadata = { title: 'Nouveau praticien' };

const USERS_LIMIT = 100;

export default async function NewPractitionerPage() {
  const me = await requireMe();
  if (!canUse(me, 'appointments', 'appointments:agenda:update')) return <AccessDenied what="la création de praticiens" />;
  const [departments, sites, users] = await Promise.all([
    loadOptional(hasPermission(me, 'org:service:read'), '/org/departments', toDepartment),
    loadOptional(hasPermission(me, 'org:site:read'), '/org/sites', toSiteAdmin),
    loadOptional(hasPermission(me, 'iam:user:read'), '/iam/users', toUserSummary, { status: 'active', limit: USERS_LIMIT }),
  ]);
  return (
    <>
      <PageHeader title="Nouveau praticien" />
      <div className="max-w-xl space-y-4">
        <PractitionerForm departments={departments} sites={sites} users={users.map((u) => ({ id: u.id, name: u.fullName }))} />
        <p><Link href="/administration/praticiens" className="text-blue-800 underline">Retour aux praticiens</Link></p>
      </div>
    </>
  );
}
