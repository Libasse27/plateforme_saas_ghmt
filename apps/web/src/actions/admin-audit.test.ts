import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { okEnvelope, problem } from '@/lib/api/test-helpers';

vi.mock('next/navigation', async () => (await import('./test-kit')).navigationMock());
vi.mock('next/cache', async () => (await import('./test-kit')).cacheMock());
vi.mock('next/headers', async () => (await import('./test-kit')).headersMock());

import { revalidatePath } from 'next/cache';
import { verifyAuditChainAction } from './admin-audit';
import { stubApi } from './test-kit';

beforeEach(() => {
  vi.stubEnv('API_URL', 'http://api.test/api/v1');
  vi.stubEnv('SESSION_COOKIE_SECURE', 'false');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.mocked(revalidatePath).mockClear();
});

describe('verifyAuditChainAction', () => {
  it('journal intègre : message et résultat structuré', async () => {
    const { calls } = stubApi(() => okEnvelope({ status: 'intact', checkedCount: 1200, fromSeq: '1', toSeq: '1200', firstBrokenSeq: null, checkedAt: '2026-10-05T10:00:00.000Z' }));
    const state = await verifyAuditChainAction();
    expect(state.ok).toBe(true);
    expect(state.message).toContain('intègre');
    expect(state.extra).toMatchObject({ verification: { status: 'intact', checkedCount: 1200 } });
    expect(calls.find((c) => c.path === '/audit-logs/verify')?.method).toBe('GET');
  });
  it('chaîne rompue : état en erreur avec le maillon', async () => {
    stubApi(() => okEnvelope({ status: 'broken', checkedCount: 10, fromSeq: '5', toSeq: '14', firstBrokenSeq: '9' }));
    const state = await verifyAuditChainAction();
    expect(state.ok).toBe(false);
    expect(state.message).toContain('9');
  });
  it('429 et 403 en français', async () => {
    stubApi(() => problem(429, 'throttled'));
    expect((await verifyAuditChainAction()).message).toContain('Trop de tentatives');
    stubApi(() => problem(403, 'permission_denied'));
    expect((await verifyAuditChainAction()).message).toContain('autorisation');
  });
});
