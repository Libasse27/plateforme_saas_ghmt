import { describe, expect, it } from 'vitest';
import { dedupKey, type DedupKeyInput } from './dedup-key';

const BASE: DedupKeyInput = {
  tenantId: '0197a3c0-0000-7000-8000-000000000001',
  sourceKey: '0197a3c0-0000-7000-8000-0000000000e1',
  typeCode: 'appointment.confirmed',
  recipientType: 'patient',
  recipientId: '0197a3c0-0000-7000-8000-0000000000a1',
  channel: 'sms',
};

describe('dedupKey', () => {
  it('produit une empreinte SHA-256 hexadécimale de 64 caractères, stable d’un appel à l’autre', () => {
    const key = dedupKey(BASE);

    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(dedupKey({ ...BASE })).toBe(key);
  });

  it('assimile l’absence de variante à une variante vide', () => {
    expect(dedupKey({ ...BASE, variant: '' })).toBe(dedupKey(BASE));
  });

  it.each([
    ['tenantId', { tenantId: '0197a3c0-0000-7000-8000-000000000002' }],
    ['sourceKey', { sourceKey: 'autre' }],
    ['typeCode', { typeCode: 'appointment.cancelled' }],
    ['recipientType', { recipientType: 'user' as const }],
    ['recipientId', { recipientId: '0197a3c0-0000-7000-8000-0000000000a2' }],
    ['channel', { channel: 'email' as const }],
    ['variant', { variant: '2026-10-07T10:00:00.000Z' }],
  ])('change quand %s change', (_name, patch) => {
    expect(dedupKey({ ...BASE, ...patch })).not.toBe(dedupKey(BASE));
  });

  it('ne confond pas deux découpages différents des mêmes caractères', () => {
    const left = dedupKey({ ...BASE, sourceKey: 'a|b', typeCode: 'c' });
    const right = dedupKey({ ...BASE, sourceKey: 'a', typeCode: 'b|c' });

    expect(left).not.toBe(right);
  });
});
