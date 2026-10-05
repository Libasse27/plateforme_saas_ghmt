import type { AuditLogView } from '@ghmt/shared';

const BOM = '﻿';
const SEPARATOR = ';';
const LINE_BREAK = '\r\n';
const FORMULA_TRIGGERS: ReadonlySet<string> = new Set(['=', '+', '-', '@', '\t', '\r']);

export const AUDIT_CSV_HEADER = [
  'seq', 'horodatage_utc', 'type_acteur', 'id_acteur', 'nom_acteur', 'action', 'type_ressource', 'id_ressource', 'id_patient',
  'resultat', 'ip', 'id_requete', 'details_json',
].join(SEPARATOR);

/** Cellule CSV : neutralise l'injection de formule (préfixe `'`) puis protège séparateurs, guillemets et sauts de ligne. */
export function csvCell(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const guarded = FORMULA_TRIGGERS.has(value[0]!) ? `'${value}` : value;
  return /[;"\r\n]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
}

function toCsvLine(row: AuditLogView): string {
  return [
    row.seq,
    row.occurredAt,
    row.actor.type,
    row.actor.userId,
    row.actor.fullName,
    row.action,
    row.resourceType,
    row.resourceId,
    row.patientId,
    row.outcome,
    row.ip,
    row.requestId,
    row.changes === null ? null : JSON.stringify(row.changes),
  ]
    .map(csvCell)
    .join(SEPARATOR);
}

/** CSV du journal : BOM UTF-8, séparateur `;`, fins de ligne CRLF (docs/10 §6). Les `changes` doivent déjà être assainis. */
export function buildAuditCsv(rows: readonly AuditLogView[]): string {
  return `${BOM}${[AUDIT_CSV_HEADER, ...rows.map(toCsvLine)].join(LINE_BREAK)}${LINE_BREAK}`;
}

function compactUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10).replaceAll('-', '');
}

export function auditCsvFilename(from: Date, to: Date): string {
  return `journal-audit-${compactUtcDate(from)}-${compactUtcDate(to)}.csv`;
}
