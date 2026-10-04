import { describe, expect, it } from 'vitest';
import { getApiUrl, isSecureCookies } from './config';

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
