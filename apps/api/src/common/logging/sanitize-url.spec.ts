import { describe, expect, it } from 'vitest';
import { sanitizeLogUrl } from './sanitize-url';

describe('sanitizeLogUrl', () => {
  it('masque le jeton d’invitation dans le chemin, y compris sur /accept', () => {
    const token = '0198a000-0000-7000-8000-00000000000a.c2VjcmV0LXRyZXMtbG9uZw';
    expect(sanitizeLogUrl(`/api/v1/auth/invitations/${token}`)).toBe('/api/v1/auth/invitations/:token');
    expect(sanitizeLogUrl(`/api/v1/auth/invitations/${token}/accept`)).toBe('/api/v1/auth/invitations/:token/accept');
  });

  it('retire la query string (termes de recherche)', () => {
    expect(sanitizeLogUrl('/api/v1/appointments?from=2026-10-04&patientId=x')).toBe('/api/v1/appointments');
  });

  it('laisse intactes les autres URL et gère l’absence d’URL', () => {
    expect(sanitizeLogUrl('/api/v1/health')).toBe('/api/v1/health');
    expect(sanitizeLogUrl(undefined)).toBeUndefined();
  });
});
