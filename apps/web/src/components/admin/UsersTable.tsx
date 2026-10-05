import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { Cell, DataTable } from '@/components/ui/DataTable';
import { LOCALE_LABELS, USER_STATUS_LABELS, USER_STATUS_TONES, type UserSummaryView } from '@/lib/domain/admin';
import { formatDateTime } from '@/lib/format/dates';

const COLUMNS = [{ header: 'Nom' }, { header: 'E-mail' }, { header: 'Statut' }, { header: 'Langue' }, { header: 'Dernière connexion' }] as const;

export function UsersTable({ users, timeZone }: { readonly users: readonly UserSummaryView[]; readonly timeZone: string }) {
  if (users.length === 0) return <p className="text-slate-700">Aucun utilisateur ne correspond à ces critères.</p>;
  return (
    <DataTable caption="Utilisateurs de l'établissement" columns={COLUMNS}>
      {users.map((user) => (
        <tr key={user.id}>
          <Cell><Link href={`/administration/utilisateurs/${user.id}`} className="font-medium text-blue-800 underline">{user.fullName}</Link></Cell>
          <Cell>{user.email}</Cell>
          <Cell><Badge tone={USER_STATUS_TONES[user.status] ?? 'neutral'}>{USER_STATUS_LABELS[user.status] ?? 'Inconnu'}</Badge></Cell>
          <Cell>{LOCALE_LABELS[user.locale] ?? user.locale}</Cell>
          <Cell>{user.lastLoginAt ? formatDateTime(user.lastLoginAt, timeZone) : 'Jamais'}</Cell>
        </tr>
      ))}
    </DataTable>
  );
}
