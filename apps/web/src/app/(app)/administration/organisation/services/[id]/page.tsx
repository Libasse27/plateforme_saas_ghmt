import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { deleteDepartmentAction, updateDepartmentAction } from '@/actions/admin-org';
import { ConfirmAction } from '@/components/admin/ConfirmAction';
import { ActionForm } from '@/components/forms/ActionForm';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Alert } from '@/components/ui/Alert';
import { PageHeader } from '@/components/ui/PageHeader';
import { hasPermission } from '@/lib/auth/me';
import { DEPARTMENT_KIND_LABELS, toDepartment } from '@/lib/domain/admin';
import { isUuid } from '@/lib/domain/raw';
import { requireMe } from '@/server/me';
import { loadOne } from '../../../_lib/page-data';

export const metadata: Metadata = { title: 'Service' };

export default async function DepartmentPage({ params }: { readonly params: Promise<{ id: string }> }) {
  const me = await requireMe();
  if (!hasPermission(me, 'org:service:read')) return <AccessDenied what="les services" />;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const loaded = await loadOne(`/org/departments/${id}`, toDepartment);
  if (!loaded.ok) return <Alert tone="error">{loaded.message}</Alert>;
  const department = loaded.value;

  return (
    <>
      <PageHeader title={department.name} description={`Service ${department.code}`} />
      <div className="max-w-xl space-y-6">
        {hasPermission(me, 'org:service:update') ? (
          <ActionForm
            action={updateDepartmentAction}
            idPrefix="dept-"
            hidden={{ id }}
            fields={[
              { kind: 'text', name: 'code', label: 'Code', required: true, defaultValue: department.code },
              { kind: 'text', name: 'name', label: 'Nom', required: true, defaultValue: department.name },
              { kind: 'select', name: 'kind', label: 'Nature', defaultValue: department.kind, options: Object.entries(DEPARTMENT_KIND_LABELS).map(([value, label]) => ({ value, label })) },
            ]}
            submitLabel="Enregistrer"
            pendingLabel="Enregistrement…"
          />
        ) : null}
        {hasPermission(me, 'org:service:delete') ? (
          <ConfirmAction action={deleteDepartmentAction} hidden={{ id }} summary="Supprimer le service" confirmLabel="Confirmer la suppression" warning="Le service ne doit contenir aucun sous-service. Cette action est auditée." idPrefix="delete-dept-" />
        ) : null}
        <p><Link href="/administration/organisation" className="text-blue-800 underline">Retour à l&apos;organisation</Link></p>
      </div>
    </>
  );
}
