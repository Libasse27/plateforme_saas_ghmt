import type { Metadata } from 'next';
import Link from 'next/link';
import { AuditFilters } from '@/components/admin/AuditFilters';
import { AuditTable } from '@/components/admin/AuditTable';
import { IntegrityCheck } from '@/components/admin/IntegrityCheck';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Alert } from '@/components/ui/Alert';
import { PageHeader } from '@/components/ui/PageHeader';
import { buttonClass } from '@/components/ui/styles';
import { hasPermission } from '@/lib/auth/me';
import { firstValues } from '@/lib/domain/admin';
import { auditApiQuery, auditHref, exportFailureMessage, parseAuditFilters, toAuditLog } from '@/lib/domain/audit';
import { isOpaqueCursor } from '@/lib/domain/notifications';
import { requireMe } from '@/server/me';
import { loadList, nextCursorOf } from '../_lib/page-data';

export const metadata: Metadata = { title: 'Journal d\'audit' };

const PAGE_SIZE = 50;

export default async function AuditPage({ searchParams }: { readonly searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireMe();
  if (!hasPermission(me, 'audit:log:read')) return <AccessDenied what="le journal d'audit" />;
  const params = firstValues(await searchParams);
  const filters = parseAuditFilters(params);
  const cursor = isOpaqueCursor(params.apres) ? params.apres : undefined;
  const result = await loadList('/audit-logs', toAuditLog, auditApiQuery(filters, me.tenant.timezone, { limit: PAGE_SIZE, cursor }));
  const nextCursor = result.ok ? nextCursorOf(result.meta) : null;
  const exportFailure = exportFailureMessage(params.export);

  return (
    <>
      <PageHeader title="Journal d'audit" description="Événements de l'établissement des 7 derniers jours par défaut (92 jours au plus). Les contenus sensibles sont masqués." />
      {exportFailure ? <div className="mb-4"><Alert tone="error">{exportFailure}</Alert></div> : null}
      <AuditFilters filters={filters} canExport={hasPermission(me, 'audit:log:export')} />
      <IntegrityCheck />
      {result.ok ? <AuditTable logs={result.value} timeZone={me.tenant.timezone} /> : <Alert tone="error">{result.message}</Alert>}
      {cursor || nextCursor ? (
        <nav aria-label="Pagination" className="mt-4 flex gap-3">
          {cursor ? <Link href={auditHref(filters, null)} className={buttonClass.secondary}>Retour au début</Link> : null}
          {nextCursor ? <Link href={auditHref(filters, nextCursor)} className={buttonClass.secondary}>Page suivante</Link> : null}
        </nav>
      ) : null}
    </>
  );
}
