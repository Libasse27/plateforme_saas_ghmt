import { bool, items, num, rec, str, strOrNull } from './raw';

/** Mappeurs tolérants des vues de notifications (docs/10 §5) : aucune importation de schemas/notifications. */

export const UNREAD_POLL_MS = 60_000;
export const UNREAD_POLL_MAX_MS = 300_000;
const BADGE_MAX = 99;

const OPAQUE_CURSOR = /^[A-Za-z0-9_-]{1,200}$/;

/** Curseur de pagination de l'API : chaîne opaque base64url (jamais interprétée par le web). */
export function isOpaqueCursor(value: string | null | undefined): value is string {
  return typeof value === 'string' && OPAQUE_CURSOR.test(value);
}

const INTERNAL_LINK = /^\/(?!\/)[A-Za-z0-9/_-]*$/;

export function isInternalLink(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 200 && INTERNAL_LINK.test(value);
}

export interface InAppMessageView {
  readonly id: string;
  readonly typeCode: string;
  readonly title: string;
  readonly body: string;
  readonly link: string | null;
  readonly createdAt: string;
  readonly readAt: string | null;
}

export function toInAppMessage(raw: unknown): InAppMessageView {
  const data = rec(raw);
  return {
    id: str(data.id),
    typeCode: str(data.typeCode),
    title: str(data.title) || 'Notification',
    body: str(data.body),
    link: isInternalLink(data.link) ? data.link : null,
    createdAt: str(data.createdAt),
    readAt: strOrNull(data.readAt),
  };
}

export interface UnreadCountView {
  readonly count: number;
  readonly capped: boolean;
}

export function toUnreadCount(raw: unknown): UnreadCountView {
  const data = rec(raw);
  return { count: Math.max(0, Math.trunc(num(data.count))), capped: bool(data.capped) };
}

/** Texte du badge de la cloche : rien à zéro, « 99+ » au-delà ou si le compteur est plafonné. */
export function badgeLabel(unread: UnreadCountView): string | null {
  if (unread.count <= 0 && !unread.capped) return null;
  return unread.capped || unread.count > BADGE_MAX ? `${BADGE_MAX}+` : String(unread.count);
}

/** Délai avant la prochaine interrogation : doublé à chaque erreur consécutive, plafonné à 5 min. */
export function backoffDelay(failures: number): number {
  return Math.min(UNREAD_POLL_MAX_MS, UNREAD_POLL_MS * 2 ** Math.max(0, failures));
}

export interface NotificationPreferenceView {
  readonly category: string;
  readonly channel: string;
  readonly enabled: boolean;
  readonly locked: boolean;
  readonly note: string | null;
}

export function toPreference(raw: unknown): NotificationPreferenceView {
  const data = rec(raw);
  return {
    category: str(data.category),
    channel: str(data.channel),
    enabled: bool(data.enabled),
    locked: data.locked !== false,
    note: strOrNull(data.note),
  };
}

/** `{ items: [...] }` (contrat) ou tableau nu. */
export function toPreferences(raw: unknown): NotificationPreferenceView[] {
  return items(Array.isArray(raw) ? raw : rec(raw).items, toPreference);
}

export const PREFERENCE_LABELS = {
  categories: { administrative: 'Notifications administratives (abonnement, quotas)' } as Readonly<Record<string, string>>,
  channels: { email: 'E-mail', inapp: 'Dans l\'application' } as Readonly<Record<string, string>>,
};

export const CONSENT_CHANNELS = ['sms', 'email'] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];

export const CONSENT_CHANNEL_LABELS: Readonly<Record<ConsentChannel, string>> = { sms: 'SMS', email: 'E-mail' };

export const CONSENT_SOURCE_LABELS: Readonly<Record<string, string>> = {
  front_desk: 'Accueil',
  patient_request: 'Demande du patient',
  sms_stop: 'Réponse STOP par SMS',
};

export interface ConsentState {
  readonly channel: ConsentChannel;
  readonly granted: boolean;
  readonly source: string | null;
  readonly recordedAt: string | null;
}

export interface ConsentEntry extends ConsentState {
  readonly id: string;
}

export interface ContactConsentsView {
  readonly patientId: string;
  readonly current: readonly ConsentState[];
  readonly history: readonly ConsentEntry[];
}

function consentChannel(value: unknown): ConsentChannel | null {
  return (CONSENT_CHANNELS as readonly string[]).includes(value as string) ? (value as ConsentChannel) : null;
}

function toConsentState(raw: unknown): ConsentState | null {
  const data = rec(raw);
  const channel = consentChannel(data.channel);
  if (!channel) return null;
  return { channel, granted: bool(data.granted), source: strOrNull(data.source), recordedAt: strOrNull(data.recordedAt) };
}

/** Toujours deux lignes (SMS puis e-mail) : un canal jamais recueilli vaut « refusé, sans date ». */
export function toContactConsents(raw: unknown): ContactConsentsView {
  const data = rec(raw);
  const received = items(data.current, toConsentState).filter((entry): entry is ConsentState => entry !== null);
  const current = CONSENT_CHANNELS.map(
    (channel): ConsentState => received.find((entry) => entry.channel === channel) ?? { channel, granted: false, source: null, recordedAt: null },
  );
  const history = items(data.history, (entry): ConsentEntry | null => {
    const state = toConsentState(entry);
    return state ? { id: str(rec(entry).id), ...state } : null;
  }).filter((entry): entry is ConsentEntry => entry !== null);
  return { patientId: str(data.patientId), current, history };
}

export interface InboxFilter {
  readonly unreadOnly: boolean;
  readonly cursor: string | undefined;
}

const UNREAD_FILTER = 'non-lues';

/** Paramètres de l'URL de la boîte : liste blanche (filtre connu, curseur opaque). */
export function parseInboxFilter(params: { readonly filtre?: string | undefined; readonly apres?: string | undefined }): InboxFilter {
  return { unreadOnly: params.filtre === UNREAD_FILTER, cursor: isOpaqueCursor(params.apres) ? params.apres : undefined };
}

export function inboxHref(unreadOnly: boolean, cursor: string | null): string {
  const search = new URLSearchParams();
  if (unreadOnly) search.set('filtre', UNREAD_FILTER);
  if (cursor) search.set('apres', cursor);
  const qs = search.toString();
  return qs ? `/notifications?${qs}` : '/notifications';
}
