import type { CashSessionView } from '@ghmt/shared';
import { validateSessionAction } from '@/actions/cashier';
import { ActionForm } from '@/components/forms/ActionForm';
import { Badge, type BadgeTone } from '@/components/ui/Badge';
import { Cell, DataTable } from '@/components/ui/DataTable';
import { CASH_SESSION_STATUS_LABELS } from '@/lib/domain/billing';
import { formatMoney } from '@/lib/domain/money';
import { formatDateTime } from '@/lib/format/dates';

const TONES: Readonly<Record<CashSessionView['status'], BadgeTone>> = { open: 'info', closed: 'warning', validated: 'success' };

export interface SessionsTableProps {
  readonly sessions: readonly CashSessionView[];
  readonly registerNames: Readonly<Record<string, string>>;
  readonly timeZone: string;
  readonly caption: string;
  /** Identifiant de l'utilisateur courant : il ne peut pas valider une session qu'il a ouverte ou clôturée. */
  readonly currentUserId?: string;
  readonly canValidate?: boolean;
}

export function SessionsTable({ sessions, registerNames, timeZone, caption, currentUserId, canValidate = false }: SessionsTableProps) {
  if (sessions.length === 0) return <p className="text-slate-700">Aucune session.</p>;
  const columns = [
    { header: 'Caisse' },
    { header: 'Ouverture' },
    { header: 'Statut' },
    { header: 'Fond', align: 'right' as const },
    { header: 'Attendu', align: 'right' as const },
    { header: 'Compté', align: 'right' as const },
    { header: 'Écart', align: 'right' as const },
  ];
  return (
    <DataTable caption={caption} columns={canValidate ? [...columns, { header: 'Validation' }] : columns}>
      {sessions.map((session) => {
        const own = currentUserId !== undefined && (session.openedBy === currentUserId || session.closedBy === currentUserId);
        return (
          <tr key={session.id}>
            <Cell>{registerNames[session.cashRegisterId] ?? 'Caisse'}</Cell>
            <Cell>{formatDateTime(session.openedAt, timeZone)}</Cell>
            <Cell><Badge tone={TONES[session.status]}>{CASH_SESSION_STATUS_LABELS[session.status]}</Badge></Cell>
            <Cell align="right">{formatMoney(session.openingFloat, session.currency)}</Cell>
            <Cell align="right">{formatMoney(session.expectedTotal, session.currency)}</Cell>
            <Cell align="right">{session.closingCounted === null ? '-' : formatMoney(session.closingCounted, session.currency)}</Cell>
            <Cell align="right" className={session.variance !== null && /[1-9]/.test(session.variance) ? 'font-semibold text-red-800' : ''}>
              {session.variance === null ? '-' : formatMoney(session.variance, session.currency)}
            </Cell>
            {canValidate ? (
              <Cell>
                {session.status !== 'closed' ? (
                  <span className="text-slate-600">-</span>
                ) : own ? (
                  <span className="text-sm text-slate-800">Un autre utilisateur doit valider cette session (séparation des tâches).</span>
                ) : (
                  <ActionForm action={validateSessionAction} idPrefix={`validate-${session.id}-`} hidden={{ sessionId: session.id }} fields={[]} submitLabel="Valider la session" pendingLabel="Validation…" />
                )}
              </Cell>
            ) : null}
          </tr>
        );
      })}
    </DataTable>
  );
}
