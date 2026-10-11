import { describe, expect, it } from 'vitest';
import { MemoryRateLimitStore } from './memory-rate-limit-store';
import { RateLimitThrottlerStorage } from './rate-limit-throttler-storage';

describe('RateLimitThrottlerStorage', () => {
  it('convertit les durées en secondes arrondies au supérieur et refuse au-delà de la limite', async () => {
    const storage = new RateLimitThrottlerStorage(new MemoryRateLimitStore(() => 0));
    const first = await storage.increment('cle', 1_500, 1, 2_500, 'default');
    expect(first).toEqual({ totalHits: 1, timeToExpire: 2, isBlocked: false, timeToBlockExpire: 0 });
    const refused = await storage.increment('cle', 1_500, 1, 2_500, 'default');
    expect(refused).toMatchObject({ totalHits: 2, isBlocked: true, timeToBlockExpire: 3 });
  });

  it('sépare les limiteurs nommés pour une même clé', async () => {
    const storage = new RateLimitThrottlerStorage(new MemoryRateLimitStore());
    await storage.increment('cle', 60_000, 1, 60_000, 'default');
    expect((await storage.increment('cle', 60_000, 1, 60_000, 'default')).isBlocked).toBe(true);
    expect((await storage.increment('cle', 60_000, 1, 60_000, 'account')).isBlocked).toBe(false);
  });
});
