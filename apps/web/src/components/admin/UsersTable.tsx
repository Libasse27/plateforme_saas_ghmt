import Link from 'next/link';
import { Badge } from '@/components/ui/Badge';
import { Cell, DataTable } from '@/components/ui/DataTable';
import { LOCALE_LABELS, USER_STATUS_LABELS, USER_STATUS_TONES, type UserSummaryView } from '@/lib/domain/admin';
import { formatDateTime } from '@/lib/format/dates';

const COLUMNS = [{ header: 'Nom' }, { header: 'E-mail' }, { header: 'Statut' }, { header: 'Second facteur' }, { header: 'Langue' }, { header: 'Dernière connexion' }, { header: 'Dernière activité' }] as const;

/** Second facteur actif (docs/11 §14.1) ; null tant que l'API ne le précise pas. */
export function mfaLabel(enrolled: boolean | null): string {
  if (enrolled === null) return 'Inconnu';
  return enrolled ? 'Activé' : 'Non activé';
}

export interface UsersTableProps {
  readonly users: readonly UserSummaryView[];
  readonly timeZone: string;
  /** Identifiant de l'administrateur principal, relu dans la politique de sécurité (docs/11 D9). */
  readonly ownerId?: string | null | undefined;
}

export function UsersTable({ users, timeZone, ownerId = null }: UsersTableProps) {
  if (users.length === 0) return <p className="text-slate-700">Aucun utilisateur ne correspond à ces critères.</p>;
  return (
    <DataTable caption="Utilisateurs de l'établissement" columns={COLUMNS}>
      {users.map((user) => (
        <tr key={user.id}>
          <Cell>
            <Link href={`/administration/utilisateurs/${user.id}`} className="font-medium text-blue-800 underline">{user.fullName}</Link>
            {user.isOwner || (ownerId !== null && user.id === ownerId) ? <span className="ml-2"><Badge tone="info">Administrateur principal</Badge></span> : null}
          </Cell>
          <Cell>{user.email}</Cell>
          <Cell>
            <Badge tone={USER_STATUS_TONES[user.status] ?? 'neutral'}>{USER_STATUS_LABELS[user.status] ?? 'Inconnu'}</Badge>
            {user.loginDelayed ? <span className="ml-2"><Badge tone="warning">Connexion ralentie</Badge></span> : null}
          </Cell>
          <Cell>{mfaLabel(user.mfaEnrolled)}</Cell>
          <Cell>{LOCALE_LABELS[user.locale] ?? user.locale}</Cell>
          <Cell>{user.lastLoginAt ? formatDateTime(user.lastLoginAt, timeZone) : 'Jamais'}</Cell>
          <Cell>{user.lastSeenAt ? formatDateTime(user.lastSeenAt, timeZone) : 'Jamais'}</Cell>
        </tr>
      ))}
    </DataTable>
  );
}
