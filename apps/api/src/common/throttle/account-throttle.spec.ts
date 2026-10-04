import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { accountTracker } from './account-throttle';

const sha = (v: string): string => createHash('sha256').update(v).digest('hex');

describe('accountTracker (H1)', () => {
  it('indexe login sur sha256(tenantSlug|email), insensible à la casse et aux espaces', () => {
    const expected = sha('clinique|awa@test.sn');
    expect(accountTracker('login', { tenantSlug: 'Clinique', email: ' AWA@test.sn ' }, '1.2.3.4')).toBe(expected);
    expect(accountTracker('login', { tenantSlug: 'clinique', email: 'awa@test.sn', password: 'x' }, '9.9.9.9')).toBe(expected);
  });

  it('indexe mfa/verify sur l’identifiant de défi', () => {
    expect(accountTracker('mfa', { challengeId: 'abc', code: '123456' }, '1.2.3.4')).toBe(sha('mfa|abc'));
  });

  it('se replie sur l’IP si le corps est inexploitable (pas de seau global partagé)', () => {
    for (const body of [undefined, null, {}, { tenantSlug: 12, email: [] }, { tenantSlug: 'a' }, 'texte']) {
      expect(accountTracker('login', body, '1.2.3.4')).toBe('ip:1.2.3.4');
    }
    expect(accountTracker(undefined, { email: 'x' }, undefined)).toBe('ip:unknown');
  });
});
