import type { Metadata } from 'next';
import Link from 'next/link';
import { markAllReadAction } from '@/actions/notifications';
import { ActionForm } from '@/components/forms/ActionForm';
import { InboxList } from '@/components/notifications/InboxList';
import { Alert } from '@/components/ui/Alert';
import { PageHeader } from '@/components/ui/PageHeader';
import { buttonClass } from '@/components/ui/styles';
import { firstValues } from '@/lib/domain/admin';
import { inboxHref, parseInboxFilter, toInAppMessage } from '@/lib/domain/notifications';
import { requireMe } from '@/server/me';
import { loadList, nextCursorOf } from '../administration/_lib/page-data';

export const metadata: Metadata = { title: 'Notifications' };

const PAGE_SIZE = 20;

export default async function NotificationsPage({ searchParams }: { readonly searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireMe();
  const { unreadOnly, cursor } = parseInboxFilter(firstValues(await searchParams));
  const result = await loadList('/notifications/inbox', toInAppMessage, { unreadOnly: unreadOnly ? 'true' : undefined, cursor, limit: PAGE_SIZE });
  const nextCursor = result.ok ? nextCursorOf(result.meta) : null;

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Messages destinés au personnel de l'établissement (abonnement, quotas). Aucune information de santé n'y figure."
        actions={<Link href="/notifications/preferences" className={buttonClass.secondary}>Préférences</Link>}
      />
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <nav aria-label="Filtre des notifications" className="flex gap-2">
          <Link href={inboxHref(false, null)} aria-current={unreadOnly ? undefined : 'page'} className={unreadOnly ? buttonClass.secondary : buttonClass.primary}>Toutes</Link>
          <Link href={inboxHref(true, null)} aria-current={unreadOnly ? 'page' : undefined} className={unreadOnly ? buttonClass.primary : buttonClass.secondary}>Non lues</Link>
        </nav>
        <ActionForm action={markAllReadAction} fields={[]} submitLabel="Tout marquer comme lu" pendingLabel="…" variant="secondary" idPrefix="read-all-" />
      </div>
      {result.ok ? <InboxList messages={result.value} timeZone={me.tenant.timezone} unreadOnly={unreadOnly} /> : <Alert tone="error">{result.message}</Alert>}
      {cursor || nextCursor ? (
        <nav aria-label="Pagination" className="mt-4 flex gap-3">
          {cursor ? <Link href={inboxHref(unreadOnly, null)} className={buttonClass.secondary}>Retour au début</Link> : null}
          {nextCursor ? <Link href={inboxHref(unreadOnly, nextCursor)} className={buttonClass.secondary}>Page suivante</Link> : null}
        </nav>
      ) : null}
    </>
  );
}
