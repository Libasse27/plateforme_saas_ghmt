import type { Metadata } from 'next';
import Link from 'next/link';
import { inviteUserAction } from '@/actions/admin-users';
import { scopeFields } from '@/components/admin/AssignmentForm';
import { ActionForm } from '@/components/forms/ActionForm';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { PageHeader } from '@/components/ui/PageHeader';
import { hasPermission } from '@/lib/auth/me';
import { LOCALE_LABELS, toDepartment, toRoleSummary, toSiteAdmin } from '@/lib/domain/admin';
import { requireMe } from '@/server/me';
import { loadOptional } from '../../_lib/page-data';

export const metadata: Metadata = { title: 'Inviter un utilisateur' };

export default async function InviteUserPage() {
  const me = await requireMe();
  if (!hasPermission(me, 'iam:user:create')) return <AccessDenied what="l'invitation d'utilisateurs" />;
  const [roles, sites, departments] = await Promise.all([
    loadOptional(hasPermission(me, 'iam:role:read'), '/iam/roles', toRoleSummary),
    loadOptional(hasPermission(me, 'org:site:read'), '/org/sites', toSiteAdmin),
    loadOptional(hasPermission(me, 'org:service:read'), '/org/departments', toDepartment),
  ]);
  const canAssign = roles.length > 0 && hasPermission(me, 'iam:assignment:create');

  return (
    <>
      <PageHeader title="Inviter un utilisateur" description="Un e-mail d'invitation à usage unique est envoyé : le compte reste inactif jusqu'à son acceptation." />
      <div className="max-w-xl space-y-4">
        <ActionForm
          action={inviteUserAction}
          idPrefix="invite-"
          fields={[
            { kind: 'text', name: 'fullName', label: 'Nom complet', required: true, autoComplete: 'off' },
            { kind: 'email', name: 'email', label: 'Adresse e-mail', required: true, autoComplete: 'off' },
            { kind: 'select', name: 'locale', label: 'Langue', defaultValue: 'fr', options: Object.entries(LOCALE_LABELS).map(([value, label]) => ({ value, label })) },
            ...(canAssign ? scopeFields({ roles, sites, departments }, false) : []),
          ]}
          submitLabel="Envoyer l'invitation"
          pendingLabel="Envoi…"
        />
        <p><Link href="/administration/utilisateurs" className="text-blue-800 underline">Retour aux utilisateurs</Link></p>
      </div>
    </>
  );
}
