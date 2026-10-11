import { describe, expect, it } from 'vitest';
import { getApiUrl, getEdgeProxySecret, getTrustedProxyHops, isSecureCookies } from './config';

describe('getApiUrl', () => {
  it('utilise API_URL sans barre finale', () => {
    expect(getApiUrl({ API_URL: 'https://api.ghmt.test/api/v1/' })).toBe('https://api.ghmt.test/api/v1');
  });
  it('retombe sur l\'API locale', () => {
    expect(getApiUrl({})).toBe('http://localhost:3000/api/v1');
    expect(getApiUrl({ API_URL: '  ' })).toBe('http://localhost:3000/api/v1');
  });
});

describe('isSecureCookies', () => {
  it('respecte SESSION_COOKIE_SECURE', () => {
    expect(isSecureCookies({ SESSION_COOKIE_SECURE: 'true', NODE_ENV: 'development' })).toBe(true);
    expect(isSecureCookies({ SESSION_COOKIE_SECURE: '1' })).toBe(true);
    expect(isSecureCookies({ SESSION_COOKIE_SECURE: 'false', NODE_ENV: 'production' })).toBe(false);
    expect(isSecureCookies({ SESSION_COOKIE_SECURE: '0' })).toBe(false);
  });
  it('est sécurisé par défaut en production uniquement', () => {
    expect(isSecureCookies({ NODE_ENV: 'production' })).toBe(true);
    expect(isSecureCookies({ NODE_ENV: 'development' })).toBe(false);
  });
});

describe('getTrustedProxyHops (docs/11 §6.4)', () => {
  it('vaut 1 par défaut hors production (compatibilité)', () => {
    expect(getTrustedProxyHops({})).toBe(1);
    expect(getTrustedProxyHops({ TRUSTED_PROXY_HOPS: '  ' })).toBe(1);
  });
  it.each(['0', '1', '2', '5'])('accepte l’entier %s hors production', (value) => {
    expect(getTrustedProxyHops({ TRUSTED_PROXY_HOPS: value })).toBe(Number(value));
  });
  it('accepte 1 à 5 en production', () => {
    expect(getTrustedProxyHops({ NODE_ENV: 'production', TRUSTED_PROXY_HOPS: '2' })).toBe(2);
  });
  it('refuse en production une valeur absente, vide ou nulle', () => {
    expect(() => getTrustedProxyHops({ NODE_ENV: 'production' })).toThrow(/TRUSTED_PROXY_HOPS/);
    expect(() => getTrustedProxyHops({ NODE_ENV: 'production', TRUSTED_PROXY_HOPS: '' })).toThrow(/TRUSTED_PROXY_HOPS/);
    expect(() => getTrustedProxyHops({ NODE_ENV: 'production', TRUSTED_PROXY_HOPS: '0' })).toThrow(/TRUSTED_PROXY_HOPS/);
  });
  it.each(['-1', '6', '1.5', 'deux', '1e1', '0x2'])('refuse la valeur invalide « %s »', (value) => {
    expect(() => getTrustedProxyHops({ TRUSTED_PROXY_HOPS: value })).toThrow(/TRUSTED_PROXY_HOPS/);
  });
});

describe('getEdgeProxySecret (docs/11 §6.4)', () => {
  const SECRET = 'k'.repeat(32);
  it('renvoie undefined hors production quand il est absent ou vide', () => {
    expect(getEdgeProxySecret({})).toBeUndefined();
    expect(getEdgeProxySecret({ EDGE_PROXY_SECRET: '   ' })).toBeUndefined();
  });
  it('renvoie le secret de 32 caractères ou plus', () => {
    expect(getEdgeProxySecret({ EDGE_PROXY_SECRET: SECRET })).toBe(SECRET);
    expect(getEdgeProxySecret({ NODE_ENV: 'production', EDGE_PROXY_SECRET: `  ${SECRET}x ` })).toBe(`${SECRET}x`);
  });
  it('refuse un secret trop court, même hors production', () => {
    expect(() => getEdgeProxySecret({ EDGE_PROXY_SECRET: 'k'.repeat(31) })).toThrow(/EDGE_PROXY_SECRET/);
  });
  it('est obligatoire en production', () => {
    expect(() => getEdgeProxySecret({ NODE_ENV: 'production' })).toThrow(/EDGE_PROXY_SECRET/);
    expect(() => getEdgeProxySecret({ NODE_ENV: 'production', EDGE_PROXY_SECRET: '' })).toThrow(/EDGE_PROXY_SECRET/);
  });
  it('ne divulgue jamais la valeur dans le message d’erreur', () => {
    try {
      getEdgeProxySecret({ EDGE_PROXY_SECRET: 'court-secret' });
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('court-secret');
    }
  });
});
