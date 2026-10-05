import { beforeEach, describe, expect, it, vi } from 'vitest';

const pageApi = vi.fn();
vi.mock('./api', () => ({ pageApi: (...args: unknown[]) => pageApi(...args) }));
vi.mock('react', async (importOriginal) => ({ ...(await importOriginal<typeof import('react')>()), cache: <T,>(fn: T) => fn }));

import { ApiError } from '@/lib/api/errors';
import { loadSubscriptionBanner } from './subscription';

beforeEach(() => {
  pageApi.mockReset();
});

describe('loadSubscriptionBanner (R1, tout utilisateur authentifié)', () => {
  it('interroge GET /subscription/status sans condition de permission', async () => {
    pageApi.mockResolvedValue({ data: { status: 'grace', trialEndsAt: null, daysLeft: null, mode: 'restricted' } });
    const banner = await loadSubscriptionBanner();
    expect(pageApi).toHaveBeenCalledWith('/subscription/status');
    expect(banner?.message).toContain('retard de paiement');
  });
  it('continuité des soins et essai', async () => {
    pageApi.mockResolvedValueOnce({ data: { status: 'suspended', trialEndsAt: null, daysLeft: null, mode: 'continuity' } });
    expect((await loadSubscriptionBanner())?.message).toContain('continuité des soins');
    pageApi.mockResolvedValueOnce({ data: { status: 'trial', trialEndsAt: '2026-10-20T00:00:00.000Z', daysLeft: 6, mode: 'normal' } });
    expect((await loadSubscriptionBanner())?.message).toBe('Période d\'essai — J-6');
  });
  it('ne bloque jamais le rendu : erreur API ou réponse inattendue donnent null', async () => {
    pageApi.mockRejectedValueOnce(new ApiError({ status: 500, code: 'internal' }));
    expect(await loadSubscriptionBanner()).toBeNull();
    pageApi.mockResolvedValueOnce({ data: {} });
    expect(await loadSubscriptionBanner()).toBeNull();
  });
});
