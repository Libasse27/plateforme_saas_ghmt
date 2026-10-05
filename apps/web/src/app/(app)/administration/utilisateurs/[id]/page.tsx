import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { revokeAssignmentAction, updateUserAction } from '@/actions/admin-users';
import { AssignmentForm } from '@/components/admin/AssignmentForm';
import { ConfirmAction } from '@/components/admin/ConfirmAction';
import { UserActions } from '@/components/admin/UserActions';
import { ActionForm } from '@/components/forms/ActionForm';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Cell, DataTable } from '@/components/ui/DataTable';
import { PageHeader } from '@/components/ui/PageHeader';
import { hasPermission } from '@/lib/auth/me';
import { LOCALE_LABELS, scopeLabel, toDepartment, toRoleSummary, toSiteAdmin, toUserDetail, USER_STATUS_LABELS, USER_STATUS_TONES } from '@/lib/domain/admin';
import { isUuid } from '@/lib/domain/raw';
import { formatDateTime } from '@/lib/format/dates';
import { requireMe } from '@/server/me';
import { loadOne, loadOptional } from '../../_lib/page-data';

export const metadata: Metadata = { title: 'Utilisateur' };

export default async function UserPage({ params }: { readonly params: Promise<{ id: string }> }) {
  const me = await requireMe();
  if (!hasPermission(me, 'iam:user:read')) return <AccessDenied what="les fiches utilisateurs" />;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const canAssign = hasPermission(me, 'iam:assignment:create');
  const [loaded, roles, sites, departments] = await Promise.all([
    loadOne(`/iam/users/${id}`, toUserDetail),
    loadOptional(canAssign && hasPermission(me, 'iam:role:read'), '/iam/roles', toRoleSummary),
    loadOptional(hasPermission(me, 'org:site:read'), '/org/sites', toSiteAdmin),
    loadOptional(hasPermission(me, 'org:service:read'), '/org/departments', toDepartment),
  ]);
  if (!loaded.ok) return <Alert tone="error">{loaded.message}</Alert>;
  const user = loaded.value;
  const tz = me.tenant.timezone;

  return (
    <>
      <PageHeader title={user.fullName} description={user.email} actions={<Badge tone={USER_STATUS_TONES[user.status] ?? 'neutral'}>{USER_STATUS_LABELS[user.status] ?? 'Inconnu'}</Badge>} />
      <div className="space-y-8">
        <p className="text-sm text-slate-800">
          Dernière connexion : {user.lastLoginAt ? formatDateTime(user.lastLoginAt, tz) : 'jamais'}
          {user.mustChangePassword ? ' · mot de passe à changer à la prochaine connexion' : ''}
        </p>
        <UserActions userId={id} status={user.status} rights={{ update: hasPermission(me, 'iam:user:update'), create: hasPermission(me, 'iam:user:create'), revokeSessions: hasPermission(me, 'iam:session:delete') }} />
        {hasPermission(me, 'iam:user:update') ? (
          <section aria-labelledby="identite" className="max-w-xl rounded-md border border-slate-300 bg-white p-4">
            <h2 id="identite" className="mb-3 text-lg font-semibold">Identité</h2>
            <ActionForm
              action={updateUserAction}
              idPrefix="user-"
              hidden={{ userId: id }}
              fields={[
                { kind: 'text', name: 'fullName', label: 'Nom complet', required: true, defaultValue: user.fullName },
                { kind: 'select', name: 'locale', label: 'Langue', defaultValue: user.locale, options: Object.entries(LOCALE_LABELS).map(([value, label]) => ({ value, label })) },
              ]}
              submitLabel="Enregistrer"
              pendingLabel="Enregistrement…"
            />
          </section>
        ) : null}
        {hasPermission(me, 'iam:assignment:read') ? (
          <section aria-labelledby="affectations" className="space-y-4">
            <h2 id="affectations" className="text-lg font-semibold">Affectations (rôle et portée)</h2>
            {user.assignments.length === 0 ? (
              <p className="text-slate-700">Aucune affectation : cet utilisateur ne peut rien faire tant qu&apos;un rôle ne lui est pas attribué.</p>
            ) : (
              <DataTable caption="Affectations de l'utilisateur" columns={[{ header: 'Rôle' }, { header: 'Portée' }, { header: 'Valable jusqu\'au' }, { header: 'Actions', hiddenHeader: true }]}>
                {user.assignments.map((assignment) => (
                  <tr key={assignment.id}>
                    <Cell>{assignment.roleName}</Cell>
                    <Cell>{scopeLabel(assignment, sites, departments)}</Cell>
                    <Cell>{assignment.validUntil ? formatDateTime(assignment.validUntil, tz) : 'Sans limite'}</Cell>
                    <Cell>
                      {hasPermission(me, 'iam:assignment:delete') ? (
                        <ConfirmAction action={revokeAssignmentAction} hidden={{ userId: id, assignmentId: assignment.id }} summary="Retirer" confirmLabel="Confirmer le retrait" warning={`Retirer le rôle « ${assignment.roleName} » à cet utilisateur ?`} idPrefix={`revoke-${assignment.id}-`} />
                      ) : null}
                    </Cell>
                  </tr>
                ))}
              </DataTable>
            )}
            {canAssign && roles.length > 0 ? (
              <div className="max-w-xl rounded-md border border-slate-300 bg-white p-4">
                <h3 className="mb-3 font-semibold">Ajouter une affectation</h3>
                <AssignmentForm userId={id} options={{ roles, sites, departments }} />
              </div>
            ) : null}
          </section>
        ) : null}
        <p><Link href="/administration/utilisateurs" className="text-blue-800 underline">Retour aux utilisateurs</Link></p>
      </div>
    </>
  );
}
