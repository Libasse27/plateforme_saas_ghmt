import type { Metadata } from 'next';
import Link from 'next/link';
import { UsersTable } from '@/components/admin/UsersTable';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Alert } from '@/components/ui/Alert';
import { PageHeader } from '@/components/ui/PageHeader';
import { buttonClass, inputClass } from '@/components/ui/styles';
import { hasPermission } from '@/lib/auth/me';
import { firstValues, toUserSummary, USER_STATUS_LABELS } from '@/lib/domain/admin';
import { isOpaqueCursor } from '@/lib/domain/notifications';
import { requireMe } from '@/server/me';
import { loadList, nextCursorOf } from '../_lib/page-data';

export const metadata: Metadata = { title: 'Utilisateurs' };

const PAGE_SIZE = 25;
const MAX_QUERY_LENGTH = 100;
const LIST_PATH = '/administration/utilisateurs';
const STATUSES = Object.keys(USER_STATUS_LABELS).filter((status) => status !== 'unknown');

interface Filters {
  readonly status: string | undefined;
  readonly q: string | undefined;
}

function listHref(filters: Filters, cursor: string | null): string {
  const search = new URLSearchParams();
  if (filters.status) search.set('statut', filters.status);
  if (filters.q) search.set('q', filters.q);
  if (cursor) search.set('apres', cursor);
  const qs = search.toString();
  return qs ? `${LIST_PATH}?${qs}` : LIST_PATH;
}

export default async function UsersPage({ searchParams }: { readonly searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireMe();
  if (!hasPermission(me, 'iam:user:read')) return <AccessDenied what="la liste des utilisateurs" />;
  const params = firstValues(await searchParams);
  const filters: Filters = {
    status: STATUSES.includes(params.statut ?? '') ? params.statut : undefined,
    q: params.q?.trim().slice(0, MAX_QUERY_LENGTH) || undefined,
  };
  const cursor = isOpaqueCursor(params.apres) ? params.apres : undefined;
  const result = await loadList('/iam/users', toUserSummary, { status: filters.status, q: filters.q, cursor, limit: PAGE_SIZE });
  const nextCursor = result.ok ? nextCursorOf(result.meta) : null;

  return (
    <>
      <PageHeader
        title="Utilisateurs"
        description="Comptes du personnel de l'établissement."
        actions={hasPermission(me, 'iam:user:create') ? <Link href={`${LIST_PATH}/inviter`} className={buttonClass.primary}>Inviter un utilisateur</Link> : undefined}
      />
      <form method="get" className="mb-6 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="statut" className="mb-1 block text-sm font-medium">Statut</label>
          <select id="statut" name="statut" defaultValue={filters.status ?? ''} className={inputClass}>
            <option value="">Tous</option>
            {STATUSES.map((status) => <option key={status} value={status}>{USER_STATUS_LABELS[status]}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="q" className="mb-1 block text-sm font-medium">Nom ou e-mail du personnel</label>
          <input id="q" name="q" defaultValue={filters.q ?? ''} maxLength={MAX_QUERY_LENGTH} className={inputClass} />
        </div>
        <button type="submit" className={buttonClass.primary}>Filtrer</button>
      </form>
      {result.ok ? <UsersTable users={result.value} timeZone={me.tenant.timezone} /> : <Alert tone="error">{result.message}</Alert>}
      {cursor || nextCursor ? (
        <nav aria-label="Pagination" className="mt-4 flex gap-3">
          {cursor ? <Link href={listHref(filters, null)} className={buttonClass.secondary}>Retour au début</Link> : null}
          {nextCursor ? <Link href={listHref(filters, nextCursor)} className={buttonClass.secondary}>Page suivante</Link> : null}
        </nav>
      ) : null}
    </>
  );
}
