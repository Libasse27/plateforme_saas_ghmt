import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Cell, DataTable } from '@/components/ui/DataTable';
import { OUTCOME_LABELS, type AuditLogView } from '@/lib/domain/audit';
import { formatDateTime } from '@/lib/format/dates';

const OUTCOME_TONES: Readonly<Record<AuditLogView['outcome'], BadgeTone>> = { success: 'success', denied: 'warning', failure: 'danger', unknown: 'neutral' };

const COLUMNS = [
  { header: 'Date' },
  { header: 'Acteur' },
  { header: 'Action' },
  { header: 'Ressource' },
  { header: 'Résultat' },
  { header: 'Détails' },
] as const;

function actorName(log: AuditLogView): string {
  return log.actor.fullName ?? (log.actor.type === 'system' ? 'Système' : log.actor.type);
}

function Details({ log }: { readonly log: AuditLogView }) {
  return (
    <details>
      <summary className="cursor-pointer text-blue-800 underline">Détails</summary>
      <dl className="mt-2 space-y-1 text-xs text-slate-800">
        <div><dt className="inline font-semibold">Maillon : </dt><dd className="inline">{log.seq}</dd></div>
        {log.resourceId ? <div><dt className="inline font-semibold">Identifiant de la ressource : </dt><dd className="inline break-all">{log.resourceId}</dd></div> : null}
        {log.ip ? <div><dt className="inline font-semibold">Adresse IP : </dt><dd className="inline">{log.ip}</dd></div> : null}
        {log.requestId ? <div><dt className="inline font-semibold">Requête : </dt><dd className="inline break-all">{log.requestId}</dd></div> : null}
      </dl>
      {log.changes ? <pre className="mt-2 max-w-md overflow-x-auto rounded bg-slate-100 p-2 text-xs">{JSON.stringify(log.changes, null, 2)}</pre> : null}
    </details>
  );
}

/** Journal d'audit : contenu déjà assaini par l'API (aucune donnée clinique). */
export function AuditTable({ logs, timeZone }: { readonly logs: readonly AuditLogView[]; readonly timeZone: string }) {
  if (logs.length === 0) return <p className="text-slate-700">Aucun événement pour ces filtres.</p>;
  return (
    <DataTable caption="Journal d'audit de l'établissement" columns={COLUMNS}>
      {logs.map((log) => (
        <tr key={log.id}>
          <Cell className="whitespace-nowrap">{formatDateTime(log.occurredAt, timeZone)}</Cell>
          <Cell>{actorName(log)}</Cell>
          <Cell><code className="text-xs">{log.action}</code></Cell>
          <Cell>{log.resourceType ?? '-'}</Cell>
          <Cell><Badge tone={OUTCOME_TONES[log.outcome]}>{OUTCOME_LABELS[log.outcome]}</Badge></Cell>
          <Cell><Details log={log} /></Cell>
        </tr>
      ))}
    </DataTable>
  );
}
