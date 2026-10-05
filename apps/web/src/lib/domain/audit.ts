import { dayRange, isDayString } from '../format/dates';
import { isOpaqueCursor } from './notifications';
import { isUuid, num, rec, str, strOrNull } from './raw';

/** Journal d'audit (docs/10 §6, §9.2) : mappeurs tolérants, filtres en liste blanche, export CSV. Aucune donnée patient dans les URL. */

export const AUDIT_OUTCOMES = ['success', 'denied', 'failure'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export const OUTCOME_LABELS: Readonly<Record<AuditOutcome | 'unknown', string>> = {
  success: 'Réussi',
  denied: 'Refusé',
  failure: 'Échec',
  unknown: 'Inconnu',
};

export interface AuditLogView {
  readonly id: string;
  readonly seq: string;
  readonly occurredAt: string;
  readonly actor: { readonly type: string; readonly userId: string | null; readonly fullName: string | null };
  readonly action: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly patientId: string | null;
  readonly outcome: AuditOutcome | 'unknown';
  readonly ip: string | null;
  readonly requestId: string | null;
  readonly changes: Readonly<Record<string, unknown>> | null;
}

function outcomeOf(value: unknown): AuditOutcome | 'unknown' {
  return (AUDIT_OUTCOMES as readonly string[]).includes(value as string) ? (value as AuditOutcome) : 'unknown';
}

export function toAuditLog(raw: unknown): AuditLogView {
  const data = rec(raw);
  const actor = rec(data.actor);
  const changes = rec(data.changes);
  return {
    id: str(data.id),
    seq: str(data.seq),
    occurredAt: str(data.occurredAt),
    actor: { type: str(actor.type, 'system'), userId: strOrNull(actor.userId), fullName: strOrNull(actor.fullName) },
    action: str(data.action),
    resourceType: strOrNull(data.resourceType),
    resourceId: strOrNull(data.resourceId),
    patientId: strOrNull(data.patientId),
    outcome: outcomeOf(data.outcome),
    ip: strOrNull(data.ip),
    requestId: strOrNull(data.requestId),
    changes: Object.keys(changes).length > 0 ? changes : null,
  };
}

export interface AuditFilters {
  readonly from?: string;
  readonly to?: string;
  readonly actor?: string;
  readonly action?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly outcome?: AuditOutcome;
}

/** Seuls ces paramètres d'URL (ou champs de formulaire) sont lus : dates, codes d'action, uuid, résultat, curseur. */
export const AUDIT_FILTER_PARAMS = ['du', 'au', 'acteur', 'action', 'ressource', 'idRessource', 'resultat', 'apres'] as const;

const ACTION_PATTERN = /^[a-z_]+(\.[a-z_]+)*(\.\*)?$/;
const RESOURCE_TYPE_PATTERN = /^[a-z_]{1,50}$/;
const MAX_ACTION_LENGTH = 100;

type Params = Readonly<Record<string, string | undefined>>;

export function parseAuditFilters(params: Params): AuditFilters {
  const { du, au, acteur, action, ressource, idRessource, resultat } = params;
  return {
    ...(isDayString(du) ? { from: du } : {}),
    ...(isDayString(au) ? { to: au } : {}),
    ...(isUuid(acteur) ? { actor: acteur } : {}),
    ...(action && action.length <= MAX_ACTION_LENGTH && ACTION_PATTERN.test(action) ? { action } : {}),
    ...(ressource && RESOURCE_TYPE_PATTERN.test(ressource) ? { resourceType: ressource } : {}),
    ...(isUuid(idRessource) ? { resourceId: idRessource } : {}),
    ...((AUDIT_OUTCOMES as readonly string[]).includes(resultat ?? '') ? { outcome: resultat as AuditOutcome } : {}),
  };
}

type ApiQuery = Record<string, string | number>;

function filterQuery(filters: AuditFilters, timeZone: string): ApiQuery {
  return {
    ...(filters.from ? { from: dayRange(filters.from, timeZone).from } : {}),
    ...(filters.to ? { to: dayRange(filters.to, timeZone).to } : {}),
    ...(filters.actor ? { actorUserId: filters.actor } : {}),
    ...(filters.action ? { action: filters.action } : {}),
    ...(filters.resourceType ? { resourceType: filters.resourceType } : {}),
    ...(filters.resourceId ? { resourceId: filters.resourceId } : {}),
    ...(filters.outcome ? { outcome: filters.outcome } : {}),
  };
}

export function auditApiQuery(filters: AuditFilters, timeZone: string, page: { readonly limit: number; readonly cursor?: string | undefined }): ApiQuery {
  return { ...filterQuery(filters, timeZone), limit: page.limit, ...(isOpaqueCursor(page.cursor) ? { cursor: page.cursor } : {}) };
}

/** Corps de POST /audit-logs/export construit depuis les champs du formulaire, sans rien hors liste blanche. */
export function auditExportFilters(fields: Params, timeZone: string): ApiQuery {
  return filterQuery(parseAuditFilters(fields), timeZone);
}

const JOURNAL_PATH = '/administration/journal';

export function auditHref(filters: AuditFilters, cursor: string | null): string {
  const search = new URLSearchParams();
  const entries: readonly (readonly [string, string | undefined])[] = [
    ['du', filters.from], ['au', filters.to], ['acteur', filters.actor], ['action', filters.action],
    ['ressource', filters.resourceType], ['idRessource', filters.resourceId], ['resultat', filters.outcome], ['apres', cursor ?? undefined],
  ];
  for (const [key, value] of entries) if (value) search.set(key, value);
  const qs = search.toString().replace(/%2A/g, '*');
  return qs ? `${JOURNAL_PATH}?${qs}` : JOURNAL_PATH;
}

export interface ChainVerificationView {
  readonly status: 'intact' | 'broken' | 'empty' | 'unknown';
  readonly checkedCount: number;
  readonly fromSeq: string | null;
  readonly toSeq: string | null;
  readonly firstBrokenSeq: string | null;
  readonly checkedAt: string | null;
}

export function toChainVerification(raw: unknown): ChainVerificationView {
  const data = rec(raw);
  const status = ['intact', 'broken', 'empty'].includes(data.status as string) ? (data.status as 'intact' | 'broken' | 'empty') : 'unknown';
  return {
    status,
    checkedCount: Math.max(0, Math.trunc(num(data.checkedCount))),
    fromSeq: strOrNull(data.fromSeq),
    toSeq: strOrNull(data.toSeq),
    firstBrokenSeq: strOrNull(data.firstBrokenSeq),
    checkedAt: strOrNull(data.checkedAt),
  };
}

export function verificationMessage(view: ChainVerificationView): string {
  switch (view.status) {
    case 'intact':
      return `Journal intègre : ${String(view.checkedCount)} maillons vérifiés (de ${view.fromSeq ?? '?'} à ${view.toSeq ?? '?'}).`;
    case 'broken':
      return `Chaîne rompue au maillon ${view.firstBrokenSeq ?? 'inconnu'} : alertez immédiatement l'équipe de sécurité.`;
    case 'empty':
      return 'Le journal est vide : rien à vérifier.';
    default:
      return 'Résultat indéterminé : relancez la vérification.';
  }
}

/** Export CSV (POST) : l'origine du navigateur doit correspondre à l'hôte servi (anti-CSRF). */
export function isSameOrigin(origin: string | null, host: string | null): boolean {
  if (!origin || !host || origin === 'null') return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

/**
 * Anti-CSRF de l'export : Fetch Metadata d'abord (`Sec-Fetch-Site`, posé par le navigateur et non falsifiable
 * par un site tiers). Il reste fiable quand `Referrer-Policy: no-referrer` fait envoyer `Origin: null` aux
 * formulaires POST. Sans cet en-tête (navigateur ancien), repli sur la comparaison Origin / hôte.
 */
export function isSameOriginRequest(headers: Headers): boolean {
  const fetchSite = headers.get('sec-fetch-site');
  if (fetchSite !== null) return fetchSite === 'same-origin';
  return isSameOrigin(headers.get('origin'), headers.get('x-forwarded-host') ?? headers.get('host'));
}

const SAFE_DISPOSITION = /^attachment; filename="[A-Za-z0-9._-]{1,100}\.csv"$/;
const FALLBACK_DISPOSITION = 'attachment; filename="journal-audit.csv"';
const CSV_TYPE = 'text/csv; charset=utf-8';

/** En-têtes de la réponse d'export : seuls type et nom de fichier (validé) de l'API sont repris. */
export function exportHeaders(upstream: Headers): Headers {
  const disposition = upstream.get('content-disposition') ?? '';
  const contentType = upstream.get('content-type') ?? '';
  const headers = new Headers();
  headers.set('content-type', contentType.startsWith('text/csv') ? contentType : CSV_TYPE);
  headers.set('content-disposition', SAFE_DISPOSITION.test(disposition) ? disposition : FALLBACK_DISPOSITION);
  headers.set('cache-control', 'no-store');
  headers.set('x-content-type-options', 'nosniff');
  return headers;
}

const EXPORT_FAILURES = {
  'trop-volumineux': 'L\'export dépasse 10 000 lignes : réduisez la période ou ajoutez des filtres.',
  abonnement: 'L\'export est bloqué pendant la période de grâce de l\'abonnement : réglez la facture en retard.',
  limite: 'Trop de tentatives d\'export, réessayez dans quelques minutes.',
  interdit: 'Vous n\'avez pas l\'autorisation d\'exporter le journal d\'audit.',
  periode: 'La période demandée est trop longue : réduisez-la.',
  erreur: 'L\'export a échoué. Réessayez dans un instant.',
} as const;

export type ExportFailureKey = keyof typeof EXPORT_FAILURES;

/** Clé fermée d'un échec d'export (passée dans l'URL de retour : jamais de texte libre ni de détail technique). */
export function exportFailureKey(error: { readonly status: number; readonly code: string }): ExportFailureKey {
  if (error.code === 'export_too_large') return 'trop-volumineux';
  if (error.code === 'subscription_grace') return 'abonnement';
  if (error.code === 'range_too_large') return 'periode';
  if (error.status === 429) return 'limite';
  if (error.status === 403) return 'interdit';
  return 'erreur';
}

export function exportFailureMessage(key: string | undefined): string | null {
  return key !== undefined && Object.hasOwn(EXPORT_FAILURES, key) ? EXPORT_FAILURES[key as ExportFailureKey] : null;
}

export function exportFailureHref(filters: AuditFilters, key: ExportFailureKey): string {
  const base = auditHref(filters, null);
  return `${base}${base.includes('?') ? '&' : '?'}export=${key}`;
}
