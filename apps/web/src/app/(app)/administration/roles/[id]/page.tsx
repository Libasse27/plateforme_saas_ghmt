import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { deleteRoleAction } from '@/actions/admin-roles';
import { ConfirmAction } from '@/components/admin/ConfirmAction';
import { RoleEditor } from '@/components/admin/RoleEditor';
import { RoleMatrix } from '@/components/admin/RoleMatrix';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { hasPermission } from '@/lib/auth/me';
import { buildPermissionMatrix, toPermissionGroups, toRoleDetail } from '@/lib/domain/admin';
import { isUuid } from '@/lib/domain/raw';
import { requireMe } from '@/server/me';
import { loadOne } from '../../_lib/page-data';

export const metadata: Metadata = { title: 'Rôle' };

export default async function RolePage({ params }: { readonly params: Promise<{ id: string }> }) {
  const me = await requireMe();
  if (!hasPermission(me, 'iam:role:read')) return <AccessDenied what="les rôles et permissions" />;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const [role, catalog] = await Promise.all([
    loadOne(`/iam/roles/${id}`, toRoleDetail),
    loadOne('/iam/permissions', (raw) => buildPermissionMatrix(toPermissionGroups(raw))),
  ]);
  if (!role.ok) return <Alert tone="error">{role.message}</Alert>;
  if (!catalog.ok) return <Alert tone="error">{catalog.message}</Alert>;
  const detail = role.value;
  const editable = !detail.isSystem && hasPermission(me, 'iam:role:update');

  return (
    <>
      <PageHeader
        title={detail.name}
        description={detail.description || `Rôle ${detail.code}`}
        actions={detail.isSystem ? <Badge tone="info">Système (lecture seule)</Badge> : undefined}
      />
      <div className="space-y-6">
        {editable ? (
          <RoleEditor role={detail} matrix={catalog.value} held={me.permissions} />
        ) : (
          <>
            {detail.isSystem ? <Alert tone="info">Les rôles système ne peuvent être ni modifiés ni supprimés. Créez un rôle personnalisé pour adapter les droits.</Alert> : null}
            <RoleMatrix matrix={catalog.value} selected={detail.permissions} held={me.permissions} readOnly />
          </>
        )}
        {!detail.isSystem && hasPermission(me, 'iam:role:delete') ? (
          <ConfirmAction action={deleteRoleAction} hidden={{ id }} summary="Supprimer le rôle" confirmLabel="Confirmer la suppression" warning="Un rôle encore affecté à des utilisateurs ne peut pas être supprimé. Cette action est auditée." idPrefix="delete-role-" />
        ) : null}
        <p><Link href="/administration/roles" className="text-blue-800 underline">Retour aux rôles</Link></p>
      </div>
    </>
  );
}
