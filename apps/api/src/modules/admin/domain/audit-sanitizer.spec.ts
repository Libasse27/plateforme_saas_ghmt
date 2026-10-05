import { describe, expect, it } from 'vitest';
import { MASKED_VALUE, sanitizeAuditChanges } from './audit-sanitizer';

describe('sanitizeAuditChanges', () => {
  it('renvoie null pour une absence de changements ou une valeur non objet', () => {
    expect(sanitizeAuditChanges(null)).toBeNull();
    expect(sanitizeAuditChanges(undefined)).toBeNull();
    expect(sanitizeAuditChanges('texte')).toBeNull();
    expect(sanitizeAuditChanges(['a'])).toBeNull();
  });

  it.each([
    'forceReason', 'cancelReason', 'comment', 'note', 'notes', 'description', 'label', 'printLabel', 'voidReason', 'text', 'body',
    'subject', 'motif', 'diagnosis', 'address', 'phone', 'email', 'nationalId', 'firstName', 'lastName', 'fullName', 'birthDate', 'q', 'query', 'term',
  ])('masque la clé « %s »', (key) => {
    expect(sanitizeAuditChanges({ [key]: 'valeur libre', autre: 'ok' })).toEqual({ [key]: MASKED_VALUE, autre: 'ok' });
  });

  it('masque les clés à toute profondeur, y compris dans les tableaux, sans tenir compte de la casse', () => {
    const result = sanitizeAuditChanges({ nested: { deeper: { Email: 'a@b.sn' } }, list: [{ comment: 'x' }, { ok: 1 }], FullName: 'Awa' });

    expect(result).toEqual({ nested: { deeper: { Email: MASKED_VALUE } }, list: [{ comment: MASKED_VALUE }, { ok: 1 }], FullName: MASKED_VALUE });
  });

  it('masque la valeur même si elle est nulle ou structurée', () => {
    expect(sanitizeAuditChanges({ comment: null, note: { a: 1 } })).toEqual({ comment: MASKED_VALUE, note: MASKED_VALUE });
  });

  it.each(['permission_denied', 'a.b:c-d_1', 'x'.repeat(64)])('conserve « reason » quand il ressemble à un code (%s)', (reason) => {
    expect(sanitizeAuditChanges({ reason })).toEqual({ reason });
  });

  it.each(['Patient séropositif', 'avec des espaces', 'x'.repeat(65), 'MAJUSCULES', ''])('masque « reason » libre (%s)', (reason) => {
    expect(sanitizeAuditChanges({ reason })).toEqual({ reason: MASKED_VALUE });
  });

  it('masque « reason » non textuel et conserve un « reason » nul', () => {
    expect(sanitizeAuditChanges({ reason: { detail: 'x' } })).toEqual({ reason: MASKED_VALUE });
    expect(sanitizeAuditChanges({ reason: 42 })).toEqual({ reason: MASKED_VALUE });
    expect(sanitizeAuditChanges({ reason: null })).toEqual({ reason: null });
  });

  it('tronque les chaînes à 200 caractères et laisse intactes les valeurs courtes, nombres et booléens', () => {
    const result = sanitizeAuditChanges({ long: 'é'.repeat(250), exact: 'a'.repeat(200), n: 3, b: false, nil: null });

    expect(result).toEqual({ long: 'é'.repeat(200), exact: 'a'.repeat(200), n: 3, b: false, nil: null });
  });

  it('limite patientIds à 50 éléments et ajoute patientIdsCount avec le total réel', () => {
    const ids = Array.from({ length: 80 }, (_, i) => `id-${i}`);

    const result = sanitizeAuditChanges({ patientIds: ids });

    expect(result?.['patientIds']).toEqual(ids.slice(0, 50));
    expect(result?.['patientIdsCount']).toBe(80);
  });

  it('conserve patientIds court et renseigne patientIdsCount', () => {
    expect(sanitizeAuditChanges({ patientIds: ['a', 'b'] })).toEqual({ patientIds: ['a', 'b'], patientIdsCount: 2 });
  });

  it('ne touche pas à patientIds s’il n’est pas un tableau (masqué par prudence)', () => {
    expect(sanitizeAuditChanges({ patientIds: 'x' })).toEqual({ patientIds: MASKED_VALUE });
  });

  it('ne mute pas l’entrée', () => {
    const input = { comment: 'x', nested: { email: 'y' }, patientIds: ['a'] };
    const snapshot = JSON.parse(JSON.stringify(input));

    sanitizeAuditChanges(input);

    expect(input).toEqual(snapshot);
  });

  it('borne la profondeur de récursion', () => {
    let deep: Record<string, unknown> = { leaf: 'x' };
    for (let i = 0; i < 30; i += 1) deep = { child: deep };

    expect(() => sanitizeAuditChanges(deep)).not.toThrow();
    expect(JSON.stringify(sanitizeAuditChanges(deep))).toContain('[tronqué]');
  });
});
