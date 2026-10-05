import { describe, expect, it } from 'vitest';
import {
  backoffDelay,
  badgeLabel,
  isInternalLink,
  PREFERENCE_LABELS,
  toContactConsents,
  toInAppMessage,
  toPreference,
  toPreferences,
  toUnreadCount,
  UNREAD_POLL_MS,
  UNREAD_POLL_MAX_MS,
  inboxHref,
  parseInboxFilter,
  isOpaqueCursor,
} from './notifications';

describe('mappeurs de la boîte in-app', () => {
  it('lit un message complet', () => {
    const view = toInAppMessage({ id: 'm1', typeCode: 'quota.sms_threshold', title: 'Quota', body: 'Corps', link: '/abonnement', createdAt: '2026-10-05T10:00:00.000Z', readAt: null });
    expect(view).toEqual({ id: 'm1', typeCode: 'quota.sms_threshold', title: 'Quota', body: 'Corps', link: '/abonnement', createdAt: '2026-10-05T10:00:00.000Z', readAt: null });
  });
  it('tolère une forme inattendue et écarte un lien externe ou dangereux', () => {
    expect(toInAppMessage(null)).toMatchObject({ id: '', title: 'Notification', body: '', link: null, readAt: null });
    expect(toInAppMessage({ id: 'x', link: 'https://evil.test' }).link).toBeNull();
    expect(toInAppMessage({ id: 'x', link: '//evil.test' }).link).toBeNull();
    expect(toInAppMessage({ id: 'x', link: '//evil' }).link).toBeNull();
    expect(toInAppMessage({ id: 'x', link: '/' }).link).toBe('/');
    expect(toInAppMessage({ id: 'x', link: 'javascript:alert(1)' }).link).toBeNull();
  });
  it('isInternalLink applique le motif du contrat', () => {
    expect(isInternalLink('/facturation/factures')).toBe(true);
    expect(isInternalLink('/a?b=1')).toBe(false);
    expect(isInternalLink(undefined)).toBe(false);
  });
  it('compteur : valeurs par défaut sûres', () => {
    expect(toUnreadCount({ count: 12, capped: false })).toEqual({ count: 12, capped: false });
    expect(toUnreadCount({ count: 999, capped: true })).toEqual({ count: 999, capped: true });
    expect(toUnreadCount('x')).toEqual({ count: 0, capped: false });
    expect(toUnreadCount({ count: -3 })).toEqual({ count: 0, capped: false });
  });
});

describe('affichage de la cloche', () => {
  it('99+ au-delà de 99 ou si plafonné, rien à zéro', () => {
    expect(badgeLabel({ count: 0, capped: false })).toBeNull();
    expect(badgeLabel({ count: 7, capped: false })).toBe('7');
    expect(badgeLabel({ count: 99, capped: false })).toBe('99');
    expect(badgeLabel({ count: 100, capped: false })).toBe('99+');
    expect(badgeLabel({ count: 5, capped: true })).toBe('99+');
  });
  it('backoff : 60 s sans erreur, doublé par erreur, plafonné à 5 min', () => {
    expect(UNREAD_POLL_MS).toBe(60_000);
    expect(backoffDelay(0)).toBe(60_000);
    expect(backoffDelay(1)).toBe(120_000);
    expect(backoffDelay(2)).toBe(240_000);
    expect(backoffDelay(3)).toBe(UNREAD_POLL_MAX_MS);
    expect(backoffDelay(50)).toBe(300_000);
  });
});

describe('préférences', () => {
  it('lit une préférence verrouillée avec sa note', () => {
    expect(toPreference({ category: 'administrative', channel: 'inapp', enabled: true, locked: true, note: null })).toEqual({
      category: 'administrative', channel: 'inapp', enabled: true, locked: true, note: null,
    });
    expect(toPreference({ category: 'administrative', channel: 'email', enabled: false, locked: false, note: 'Note' }).note).toBe('Note');
  });
  it('tolère le vide', () => {
    expect(toPreference(undefined)).toEqual({ category: '', channel: '', enabled: false, locked: true, note: null });
  });
  it('liste : enveloppe { items } ou tableau nu', () => {
    const entry = { category: 'administrative', channel: 'email', enabled: true, locked: false, note: null };
    expect(toPreferences({ items: [entry] })).toHaveLength(1);
    expect(toPreferences([entry, entry])).toHaveLength(2);
    expect(toPreferences('x')).toEqual([]);
    expect(toPreferences(null)).toEqual([]);
  });
  it('libellés français', () => {
    expect(PREFERENCE_LABELS.channels.email).toBe('E-mail');
    expect(PREFERENCE_LABELS.categories.administrative).toContain('administratives');
  });
});

describe('consentements aux rappels', () => {
  it('garantit les deux canaux, même jamais recueillis', () => {
    const view = toContactConsents({ patientId: 'p1', current: [{ channel: 'sms', purpose: 'appointment_reminder', granted: true, source: 'front_desk', recordedAt: '2026-10-01T08:00:00.000Z' }], history: [] });
    expect(view.current.map((c) => c.channel)).toEqual(['sms', 'email']);
    expect(view.current[0]).toMatchObject({ granted: true, source: 'front_desk' });
    expect(view.current[1]).toMatchObject({ granted: false, source: null, recordedAt: null });
  });
  it('lit l\'historique et tolère une réponse vide', () => {
    const view = toContactConsents({ patientId: 'p1', current: [], history: [{ id: 'h1', channel: 'sms', granted: false, source: 'sms_stop', recordedAt: '2026-10-02T08:00:00.000Z' }] });
    expect(view.history).toEqual([{ id: 'h1', channel: 'sms', granted: false, source: 'sms_stop', recordedAt: '2026-10-02T08:00:00.000Z' }]);
    expect(toContactConsents(null).current).toHaveLength(2);
    expect(toContactConsents(null).history).toEqual([]);
  });
  it('ignore un canal inconnu', () => {
    expect(toContactConsents({ current: [{ channel: 'fax', granted: true }] }).current.every((c) => c.granted === false)).toBe(true);
  });
});

describe('navigation de la boîte', () => {
  it('curseur opaque : base64url seulement', () => {
    expect(isOpaqueCursor('MTIz-_')).toBe(true);
    expect(isOpaqueCursor('a b')).toBe(false);
    expect(isOpaqueCursor('')).toBe(false);
    expect(isOpaqueCursor('a'.repeat(201))).toBe(false);
  });
  it('filtre et curseur : seuls des paramètres valides', () => {
    expect(parseInboxFilter({ filtre: 'non-lues', apres: 'MDE5MGMxYTAtMDAwMA' })).toEqual({ unreadOnly: true, cursor: 'MDE5MGMxYTAtMDAwMA' });
    expect(parseInboxFilter({ filtre: 'autre', apres: '../x' })).toEqual({ unreadOnly: false, cursor: undefined });
  });
  it('construit les liens sans donnée patient', () => {
    expect(inboxHref(true, null)).toBe('/notifications?filtre=non-lues');
    expect(inboxHref(false, null)).toBe('/notifications');
    expect(inboxHref(true, 'abc')).toBe('/notifications?filtre=non-lues&apres=abc');
  });
});
