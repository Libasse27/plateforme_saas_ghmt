import type { Metadata } from 'next';
import Link from 'next/link';
import { RoleEditor } from '@/components/admin/RoleEditor';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Alert } from '@/components/ui/Alert';
import { PageHeader } from '@/components/ui/PageHeader';
import { hasPermission } from '@/lib/auth/me';
import { buildPermissionMatrix, toPermissionGroups } from '@/lib/domain/admin';
import { requireMe } from '@/server/me';
import { loadOne } from '../../_lib/page-data';

export const metadata: Metadata = { title: 'Nouveau rôle' };

export default async function NewRolePage() {
  const me = await requireMe();
  if (!hasPermission(me, 'iam:role:create')) return <AccessDenied what="la création de rôles" />;
  const catalog = await loadOne('/iam/permissions', (raw) => buildPermissionMatrix(toPermissionGroups(raw)));
  if (!catalog.ok) return <Alert tone="error">{catalog.message}</Alert>;
  return (
    <>
      <PageHeader title="Nouveau rôle" description="Choisissez les permissions du rôle. Vous ne pouvez accorder que celles que vous détenez." />
      <RoleEditor matrix={catalog.value} held={me.permissions} />
      <p className="mt-6"><Link href="/administration/roles" className="text-blue-800 underline">Retour aux rôles</Link></p>
    </>
  );
}
