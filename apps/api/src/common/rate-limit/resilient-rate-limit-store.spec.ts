import { describe, expect, it, vi } from 'vitest';
import { MemoryRateLimitStore } from './memory-rate-limit-store';
import { PRUDENT_ADMISSIONS_PER_MINUTE, PRUDENT_RETRY_AFTER_MS, ResilientRateLimitStore } from './resilient-rate-limit-store';
import type { RateLimitStore } from './rate-limit-store';

function brokenStore(): RateLimitStore {
  const fail = () => Promise.reject(new Error('redis indisponible'));
  return { hit: fail, gate: fail, release: fail, get: fail, reset: fail };
}

function setup(primary: RateLimitStore) {
  let now = 10_000_000;
  const logs: string[] = [];
  const recoveries: number[] = [];
  const store = new ResilientRateLimitStore(primary, new MemoryRateLimitStore(() => now), {
    now: () => now,
    onDegraded: (reason) => logs.push(reason),
    onRecovered: (degradedForMs) => recoveries.push(degradedForMs),
  });
  return { store, logs, recoveries, advance: (ms: number) => (now += ms) };
}

describe('ResilientRateLimitStore', () => {
  it('délègue au stockage principal tant qu’il répond', async () => {
    const primary = new MemoryRateLimitStore();
    const spy = vi.spyOn(primary, 'hit');
    const { store } = setup(primary);
    await store.hit('k', 1_000, 5, 1_000);
    expect(spy).toHaveBeenCalledOnce();
    expect(store.isDegraded()).toBe(false);
  });

  it('se replie sur la mémoire quand le stockage principal échoue : la limite reste appliquée', async () => {
    const { store } = setup(brokenStore());
    for (let i = 0; i < 3; i += 1) expect((await store.hit('k', 60_000, 3, 60_000)).isBlocked).toBe(false);
    expect((await store.hit('k', 60_000, 3, 60_000)).isBlocked).toBe(true);
    expect(store.isDegraded()).toBe(true);
  });

  it('repli prudent (décision 24) : un identifiant déjà en échec pendant la panne est refusé, quel que soit le barème', async () => {
    const { store } = setup(brokenStore());
    const schedule = [0, 0, 0, 0, 30];
    expect((await store.gate('login', 60_000, 1, schedule, null)).allowed).toBe(true);
    const refused = await store.gate('login', 60_000, 2, schedule, null);
    expect(refused).toEqual({ allowed: false, retryAfterMs: PRUDENT_RETRY_AFTER_MS, count: 1 });
    // Une réservation rendue (mot de passe juste devant un second facteur) ne laisse pas d'échec : l'identifiant repasse.
    await store.release('login');
    expect((await store.gate('login', 60_000, 3, schedule, null)).allowed).toBe(true);
  });

  it('repli prudent : un échec antérieur à la panne (mémoire résiduelle) ne bloque pas l’identifiant', async () => {
    const primary = new MemoryRateLimitStore();
    vi.spyOn(primary, 'gate').mockRejectedValueOnce(new Error('coupure'));
    const { store, advance } = setup(primary);
    expect((await store.gate('login', 3_600_000, 1, [0, 0, 0, 0, 30], null)).allowed).toBe(true);
    advance(6_000);
    await store.hit('ping', 1_000, 5, 0);
    expect(store.isDegraded()).toBe(false);
    vi.spyOn(primary, 'gate').mockRejectedValue(new Error('coupure'));
    advance(1_000);
    expect((await store.gate('login', 3_600_000, 2, [0, 0, 0, 0, 30], null)).allowed).toBe(true);
  });

  it('repli prudent : les admissions de l’instance sont plafonnées par minute pendant la panne', async () => {
    const { store, advance } = setup(brokenStore());
    for (let i = 0; i < PRUDENT_ADMISSIONS_PER_MINUTE; i += 1) {
      expect((await store.gate(`id-${i}`, 60_000, 1, [0], null)).allowed).toBe(true);
    }
    const capped = await store.gate('id-extra', 60_000, 1, [0], null);
    expect(capped.allowed).toBe(false);
    expect(capped.retryAfterMs).toBeGreaterThan(0);
    advance(60_001);
    expect((await store.gate('id-extra', 60_000, 1, [0], null)).allowed).toBe(true);
  });

  it('applique aussi le compteur d’échecs en repli', async () => {
    const { store } = setup(brokenStore());
    await store.gate('f', 60_000, 1, [0], null);
    expect(await store.get('f')).toEqual({ count: 1, lastAtMs: 1 });
    await store.reset('f');
    expect(await store.get('f')).toBeNull();
  });

  it('journalise une seule fois l’entrée en mode dégradé, même si la panne dure (pas un message par requête ni par minute)', async () => {
    const { store, logs, recoveries, advance } = setup(brokenStore());
    await store.hit('a', 1_000, 5, 0);
    await store.hit('b', 1_000, 5, 0);
    for (let i = 0; i < 30; i += 1) {
      advance(6_000);
      await store.hit(`c${i}`, 1_000, 5, 0);
    }

    expect(logs).toEqual(['Error']);
    expect(recoveries).toEqual([]);
    expect(store.isDegraded()).toBe(true);
  });

  it('reste dégradé tant que le stockage principal n’a pas répondu, puis journalise une seule fois le retour', async () => {
    const primary = new MemoryRateLimitStore();
    const hit = vi.spyOn(primary, 'hit').mockRejectedValueOnce(new Error('coupure')).mockRejectedValueOnce(new Error('coupure'));
    const { store, logs, recoveries, advance } = setup(primary);
    await store.hit('k', 1_000, 5, 0);
    advance(6_000);
    // Pause écoulée sans requête : l'état exposé reste « dégradé » (aucune réponse du principal depuis la panne).
    expect(store.isDegraded()).toBe(true);
    await store.hit('k', 1_000, 5, 0);
    advance(6_000);
    await store.hit('k', 1_000, 5, 0);
    await store.hit('k', 1_000, 5, 0);

    expect(hit).toHaveBeenCalledTimes(4);
    expect(logs).toHaveLength(1);
    expect(recoveries).toEqual([12_000]);
    expect(store.isDegraded()).toBe(false);
  });

  it('ne réessaie pas le stockage principal pendant la pause, puis le réessaie', async () => {
    const primary = new MemoryRateLimitStore();
    const hit = vi.spyOn(primary, 'hit').mockRejectedValueOnce(new Error('coupure'));
    const { store, advance } = setup(primary);
    await store.hit('k', 1_000, 5, 0);
    await store.hit('k', 1_000, 5, 0);
    expect(hit).toHaveBeenCalledTimes(1);
    advance(6_000);
    await store.hit('k', 1_000, 5, 0);
    expect(hit).toHaveBeenCalledTimes(2);
    expect(store.isDegraded()).toBe(false);
  });
});
