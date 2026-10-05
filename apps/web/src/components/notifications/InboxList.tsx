import Link from 'next/link';
import { markReadAction } from '@/actions/notifications';
import { ActionForm } from '@/components/forms/ActionForm';
import { Badge } from '@/components/ui/Badge';
import { formatDateTime } from '@/lib/format/dates';
import type { InAppMessageView } from '@/lib/domain/notifications';

export interface InboxListProps {
  readonly messages: readonly InAppMessageView[];
  readonly timeZone: string;
  readonly unreadOnly: boolean;
}

function MessageItem({ message, timeZone }: { readonly message: InAppMessageView; readonly timeZone: string }) {
  const unread = message.readAt === null;
  return (
    <li className={`rounded-md border p-4 ${unread ? 'border-blue-700 bg-blue-50' : 'border-slate-300 bg-white'}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="font-semibold text-slate-900">{message.title}</h2>
        {unread ? <Badge tone="info">Non lu</Badge> : null}
        <time dateTime={message.createdAt} className="text-sm text-slate-700">{formatDateTime(message.createdAt, timeZone)}</time>
      </div>
      {message.body ? <p className="mt-2 text-slate-800">{message.body}</p> : null}
      <div className="mt-3 flex flex-wrap items-start gap-3">
        {message.link ? (
          <Link href={message.link} className="font-semibold text-blue-800 underline">
            Ouvrir<span className="sr-only"> : {message.title}</span>
          </Link>
        ) : null}
        {unread ? (
          <ActionForm action={markReadAction} fields={[]} hidden={{ id: message.id }} submitLabel="Marquer comme lu" pendingLabel="…" variant="secondary" idPrefix={`read-${message.id}-`} />
        ) : null}
      </div>
    </li>
  );
}

/** Boîte de réception in-app : messages du personnel uniquement (jamais de donnée de santé, docs/10 §5.1). */
export function InboxList({ messages, timeZone, unreadOnly }: InboxListProps) {
  if (messages.length === 0) {
    return <p className="text-slate-700">{unreadOnly ? 'Aucune notification non lue.' : 'Aucune notification pour le moment.'}</p>;
  }
  return (
    <ul className="space-y-3">
      {messages.map((message) => (
        <MessageItem key={message.id} message={message} timeZone={timeZone} />
      ))}
    </ul>
  );
}
