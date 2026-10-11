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

  it('replie sur l’IP regroupée : IPv6 par /64, IPv4 encapsulée ramenée à l’IPv4', () => {
    expect(accountTracker('login', {}, '2001:db8:abcd:12::1')).toBe('ip:2001:db8:abcd:12::/64');
    expect(accountTracker('login', {}, '2001:db8:abcd:12:aaaa:bbbb:cccc:dddd')).toBe('ip:2001:db8:abcd:12::/64');
    expect(accountTracker('login', {}, '::ffff:203.0.113.7')).toBe('ip:203.0.113.7');
  });

  it('indexe mot de passe oublié et renvoi d’inscription sur un préfixe distinct de login', () => {
    const body = { tenantSlug: 'Clinique', email: 'AWA@test.sn' };
    expect(accountTracker('password_forgot', body, '1.2.3.4')).toBe(sha('pwd|clinique|awa@test.sn'));
    expect(accountTracker('signup_resend', body, '1.2.3.4')).toBe(sha('signup|clinique|awa@test.sn'));
    expect(accountTracker('password_forgot', body, '1.2.3.4')).not.toBe(accountTracker('login', body, '1.2.3.4'));
  });

  it('indexe la réinitialisation sur le jeton normalisé comme parseOpaqueToken : la casse du tenant ne change pas le seau (docs/11 §14.2)', () => {
    const tenantId = '01a12758-e71d-75ad-b757-26bc4ce9446e';
    const secret = 'A'.repeat(21) + 'b'.repeat(22);
    const expected = sha(`reset|${tenantId}.${secret}`);
    expect(accountTracker('password_reset', { token: `${tenantId}.${secret}` }, '1.2.3.4')).toBe(expected);
    expect(accountTracker('password_reset', { token: `${tenantId.toUpperCase()}.${secret}` }, '9.9.9.9')).toBe(expected);
    // Le secret reste sensible à la casse : c'est un autre jeton.
    expect(accountTracker('password_reset', { token: `${tenantId}.${secret.toLowerCase()}` }, '1.2.3.4')).not.toBe(expected);
    // Jeton illisible (refusé par le service) : seau propre à la valeur reçue.
    expect(accountTracker('password_reset', { token: 'AbC.def' }, '1.2.3.4')).toBe(sha('reset|AbC.def'));
    expect(accountTracker('password_reset', { token: '' }, '1.2.3.4')).toBe('ip:1.2.3.4');
    expect(accountTracker('password_reset', { token: 'x'.repeat(513) }, '1.2.3.4')).toBe('ip:1.2.3.4');
  });
});
