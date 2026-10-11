import { describe, expect, it } from 'vitest';
import { MemoryRateLimitStore } from './memory-rate-limit-store';

function storeWithClock(start = 1_000_000) {
  let now = start;
  const store = new MemoryRateLimitStore(() => now);
  return { store, advance: (ms: number) => (now += ms) };
}

describe('MemoryRateLimitStore.hit', () => {
  it('accepte jusqu’à la limite puis refuse et bloque', async () => {
    const { store } = storeWithClock();
    for (let i = 1; i <= 3; i += 1) {
      const hit = await store.hit('k', 60_000, 3, 60_000);
      expect(hit).toMatchObject({ totalHits: i, isBlocked: false, timeToBlockExpireMs: 0 });
    }
    const refused = await store.hit('k', 60_000, 3, 60_000);
    expect(refused.isBlocked).toBe(true);
    expect(refused.totalHits).toBe(4);
    expect(refused.timeToBlockExpireMs).toBe(60_000);
  });

  it('rouvre la fenêtre une fois le blocage et la fenêtre écoulés', async () => {
    const { store, advance } = storeWithClock();
    for (let i = 0; i < 4; i += 1) await store.hit('k', 1_000, 3, 5_000);
    advance(4_000);
    expect((await store.hit('k', 1_000, 3, 5_000)).isBlocked).toBe(true);
    advance(1_500);
    expect(await store.hit('k', 1_000, 3, 5_000)).toMatchObject({ totalHits: 1, isBlocked: false });
  });

  it('sans durée de blocage, refuse tant que la fenêtre est pleine sans compter les refus', async () => {
    const { store, advance } = storeWithClock();
    for (let i = 0; i < 3; i += 1) await store.hit('k', 1_000, 3, 0);
    expect((await store.hit('k', 1_000, 3, 0)).isBlocked).toBe(true);
    advance(1_001);
    expect(await store.hit('k', 1_000, 3, 0)).toMatchObject({ totalHits: 1, isBlocked: false });
  });

  it('isole les clés entre elles', async () => {
    const { store } = storeWithClock();
    await store.hit('a', 60_000, 1, 60_000);
    expect((await store.hit('a', 60_000, 1, 60_000)).isBlocked).toBe(true);
    expect((await store.hit('b', 60_000, 1, 60_000)).isBlocked).toBe(false);
  });

  it('reset efface fenêtre et blocage', async () => {
    const { store } = storeWithClock();
    await store.hit('k', 60_000, 1, 60_000);
    await store.hit('k', 60_000, 1, 60_000);
    await store.reset('k');
    expect(await store.hit('k', 60_000, 1, 60_000)).toMatchObject({ totalHits: 1, isBlocked: false });
  });
});

describe('MemoryRateLimitStore.recordFailure', () => {
  it('compte les échecs, date le dernier et expire après la durée de vie', async () => {
    const { store, advance } = storeWithClock(5_000);
    expect(await store.get('f')).toBeNull();
    expect(await store.recordFailure('f', 10_000, 5_000)).toEqual({ count: 1, lastAtMs: 5_000 });
    advance(2_000);
    expect(await store.recordFailure('f', 10_000, 7_000)).toEqual({ count: 2, lastAtMs: 7_000 });
    expect(await store.get('f')).toEqual({ count: 2, lastAtMs: 7_000 });
    advance(10_001);
    expect(await store.get('f')).toBeNull();
    expect(await store.recordFailure('f', 10_000, 17_001)).toEqual({ count: 1, lastAtMs: 17_001 });
  });

  it('reset remet le compteur à zéro', async () => {
    const { store } = storeWithClock();
    await store.recordFailure('f', 10_000, 1);
    await store.reset('f');
    expect(await store.get('f')).toBeNull();
  });
});

describe('MemoryRateLimitStore.gate (délai progressif atomique)', () => {
  const SCHEDULE = [0, 0, 0, 0, 30, 60, 120, 300, 600, 900];
  const TTL = 24 * 3_600_000;

  it('admet et compte les quatre premières tentatives, refuse ensuite pendant 30 s', async () => {
    const { store } = storeWithClock();
    for (let i = 1; i <= 5; i += 1) expect(await store.gate('g', TTL, 1_000_000, SCHEDULE, null)).toEqual({ allowed: true, retryAfterMs: 0, count: i });

    const refused = await store.gate('g', TTL, 1_010_000, SCHEDULE, null);

    expect(refused).toEqual({ allowed: false, retryAfterMs: 20_000, count: 5 });
  });

  it('admet de nouveau une fois le délai écoulé, avec le palier suivant', async () => {
    const { store } = storeWithClock();
    for (let i = 0; i < 5; i += 1) await store.gate('g', TTL, 1_000_000, SCHEDULE, null);

    expect((await store.gate('g', TTL, 1_030_001, SCHEDULE, null)).count).toBe(6);
    expect((await store.gate('g', TTL, 1_030_002, SCHEDULE, null)).retryAfterMs).toBeGreaterThan(59_000);
  });

  it('plafonne le délai quand un plafond est fourni (réseau de confiance)', async () => {
    const { store } = storeWithClock();
    // Dix échecs espacés de plus de 900 s : chaque tentative est admise, puis le dixième palier s'applique.
    for (let i = 0; i < 10; i += 1) expect((await store.gate('g', TTL, 1_000_000 + i * 1_000_000, SCHEDULE, null)).allowed).toBe(true);
    const last = 1_000_000 + 9 * 1_000_000;

    expect((await store.gate('g', TTL, last, SCHEDULE, 60)).retryAfterMs).toBe(60_000);
    expect((await store.gate('g', TTL, last, SCHEDULE, null)).retryAfterMs).toBe(900_000);
  });

  it('une seule de deux tentatives simultanées franchit un palier', async () => {
    const { store } = storeWithClock();
    for (let i = 0; i < 4; i += 1) await store.gate('g', TTL, 1_000_000, SCHEDULE, null);

    const [a, b] = await Promise.all([store.gate('g', TTL, 1_000_000, SCHEDULE, null), store.gate('g', TTL, 1_000_000, SCHEDULE, null)]);

    expect([a.allowed, b.allowed].sort()).toEqual([false, true]);
  });

  it('release retire un échec puis supprime la clé', async () => {
    const { store } = storeWithClock();
    await store.gate('g', TTL, 1, SCHEDULE, null);
    await store.gate('g', TTL, 1, SCHEDULE, null);
    await store.release('g');
    expect((await store.get('g'))!.count).toBe(1);
    await store.release('g');
    expect(await store.get('g')).toBeNull();
  });

  it('repart de zéro 24 h après le dernier échec', async () => {
    const { store } = storeWithClock();
    for (let i = 0; i < 6; i += 1) await store.gate('g', TTL, 1_000_000, SCHEDULE, null);

    expect(await store.gate('g', TTL, 1_000_000 + TTL + 1, SCHEDULE, null)).toMatchObject({ allowed: true, count: 1 });
  });
});

describe('MemoryRateLimitStore.release (date du dernier échec)', () => {
  const SCHEDULE = [0, 0, 0, 0, 30, 60, 120, 300, 600, 900];
  const TTL = 24 * 3_600_000;

  it('rend aussi la date du dernier échec : une réservation rendue ne relance pas le délai', async () => {
    const { store } = storeWithClock();
    for (let i = 0; i < 5; i += 1) await store.gate('g', TTL, 1_000_000, SCHEDULE, null);
    expect((await store.gate('g', TTL, 1_031_000, SCHEDULE, null)).allowed).toBe(true);

    await store.release('g');

    expect(await store.get('g')).toEqual({ count: 5, lastAtMs: 1_000_000 });
    expect((await store.gate('g', TTL, 1_031_500, SCHEDULE, null)).allowed).toBe(true);
  });
});
