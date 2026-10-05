import type { Metadata } from 'next';
import Link from 'next/link';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { buttonClass } from '@/components/ui/styles';
import { hasPermission } from '@/lib/auth/me';
import { toRoleSummary, type RoleSummaryView } from '@/lib/domain/admin';
import { requireMe } from '@/server/me';
import { loadList } from '../_lib/page-data';

export const metadata: Metadata = { title: 'Rôles et permissions' };

function RoleList({ title, id, roles, linkLabel, empty }: { readonly title: string; readonly id: string; readonly roles: readonly RoleSummaryView[]; readonly linkLabel: string; readonly empty: string }) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <h2 id={id} className="text-lg font-semibold">{title}</h2>
      {roles.length === 0 ? (
        <p className="text-slate-700">{empty}</p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-md border border-slate-300 bg-white">
          {roles.map((role) => (
            <li key={role.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <span>
                <span className="font-medium">{role.name}</span>{' '}
                {role.isSystem ? <Badge tone="info">Système</Badge> : null}{' '}
                <span className="text-slate-700">{role.permissionCount} permission{role.permissionCount > 1 ? 's' : ''}</span>
                {role.description ? <span className="block text-sm text-slate-700">{role.description}</span> : null}
              </span>
              <Link href={`/administration/roles/${role.id}`} className="text-blue-800 underline">{linkLabel}<span className="sr-only"> : {role.name}</span></Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default async function RolesPage() {
  const me = await requireMe();
  if (!hasPermission(me, 'iam:role:read')) return <AccessDenied what="les rôles et permissions" />;
  const result = await loadList('/iam/roles', toRoleSummary);
  if (!result.ok) return <Alert tone="error">{result.message}</Alert>;
  const system = result.value.filter((role) => role.isSystem);
  const custom = result.value.filter((role) => !role.isSystem);

  return (
    <>
      <PageHeader
        title="Rôles et permissions"
        description="Les rôles système sont fournis avec la plateforme (lecture seule). Créez des rôles personnalisés pour vos besoins."
        actions={hasPermission(me, 'iam:role:create') ? <Link href="/administration/roles/nouveau" className={buttonClass.primary}>Nouveau rôle</Link> : undefined}
      />
      <div className="space-y-8">
        <RoleList title="Rôles personnalisés" id="personnalises" roles={custom} linkLabel="Ouvrir" empty="Aucun rôle personnalisé." />
        <RoleList title="Rôles système" id="systeme" roles={system} linkLabel="Consulter" empty="Aucun rôle système." />
      </div>
    </>
  );
}
