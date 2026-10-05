import { describe, expect, it } from 'vitest';
import { REDACTED_LOG_PATHS } from './redact';

describe('masquage des journaux (L10)', () => {
  it('couvre les en-têtes de signature de webhook et les secrets d’authentification', () => {
    for (const header of ['x-token', 'x-sandbox-signature', 'x-signature', 'x-hub-signature-256', 'x-ghmt-signature', 'authorization', 'cookie']) {
      expect(REDACTED_LOG_PATHS).toContain(`req.headers["${header}"]`);
    }
    expect(REDACTED_LOG_PATHS).toContain('res.headers["set-cookie"]');
  });
});
