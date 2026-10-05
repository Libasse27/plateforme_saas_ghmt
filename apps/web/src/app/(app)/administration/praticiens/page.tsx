import type { Metadata } from 'next';
import Link from 'next/link';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { Cell, DataTable } from '@/components/ui/DataTable';
import { PageHeader } from '@/components/ui/PageHeader';
import { buttonClass } from '@/components/ui/styles';
import { canUse, hasPermission } from '@/lib/auth/me';
import { firstValues, toPractitionerAdmin } from '@/lib/domain/admin';
import { isOpaqueCursor } from '@/lib/domain/notifications';
import { requireMe } from '@/server/me';
import { loadList, nextCursorOf } from '../_lib/page-data';

export const metadata: Metadata = { title: 'Praticiens' };

const PAGE_SIZE = 50;
const LIST_PATH = '/administration/praticiens';

export default async function PractitionersPage({ searchParams }: { readonly searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireMe();
  if (!canUse(me, 'appointments', 'appointments:agenda:read')) return <AccessDenied what="les praticiens" />;
  const params = firstValues(await searchParams);
  const cursor = isOpaqueCursor(params.apres) ? params.apres : undefined;
  const result = await loadList('/practitioners', toPractitionerAdmin, { cursor, limit: PAGE_SIZE });
  const nextCursor = result.ok ? nextCursorOf(result.meta) : null;

  return (
    <>
      <PageHeader
        title="Praticiens"
        description="Professionnels de santé réservables dans l'agenda."
        actions={hasPermission(me, 'appointments:agenda:update') ? <Link href={`${LIST_PATH}/nouveau`} className={buttonClass.primary}>Nouveau praticien</Link> : undefined}
      />
      {!result.ok ? (
        <Alert tone="error">{result.message}</Alert>
      ) : result.value.length === 0 ? (
        <p className="text-slate-700">Aucun praticien.</p>
      ) : (
        <DataTable caption="Praticiens de l'établissement" columns={[{ header: 'Nom' }, { header: 'Spécialité' }, { header: 'Consultation' }, { header: 'Réservable' }]}>
          {result.value.map((practitioner) => (
            <tr key={practitioner.id}>
              <Cell><Link href={`${LIST_PATH}/${practitioner.id}`} className="font-medium text-blue-800 underline">{practitioner.fullName}</Link></Cell>
              <Cell>{practitioner.specialty || '-'}</Cell>
              <Cell>{practitioner.defaultConsultMinutes} min</Cell>
              <Cell><Badge tone={practitioner.isBookable ? 'success' : 'neutral'}>{practitioner.isBookable ? 'Oui' : 'Non'}</Badge></Cell>
            </tr>
          ))}
        </DataTable>
      )}
      {cursor || nextCursor ? (
        <nav aria-label="Pagination" className="mt-4 flex gap-3">
          {cursor ? <Link href={LIST_PATH} className={buttonClass.secondary}>Retour au début</Link> : null}
          {nextCursor ? <Link href={`${LIST_PATH}?apres=${encodeURIComponent(nextCursor)}`} className={buttonClass.secondary}>Page suivante</Link> : null}
        </nav>
      ) : null}
    </>
  );
}
