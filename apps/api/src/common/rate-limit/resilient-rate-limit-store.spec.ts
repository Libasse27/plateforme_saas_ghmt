import { describe, expect, it, vi } from 'vitest';
import { MemoryRateLimitStore } from './memory-rate-limit-store';
import { ResilientRateLimitStore } from './resilient-rate-limit-store';
import type { RateLimitStore } from './rate-limit-store';

function brokenStore(): RateLimitStore {
  const fail = () => Promise.reject(new Error('redis indisponible'));
  return { hit: fail, recordFailure: fail, gate: fail, release: fail, get: fail, reset: fail };
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

  it('applique aussi le compteur d’échecs en repli', async () => {
    const { store } = setup(brokenStore());
    await store.recordFailure('f', 60_000, 1);
    expect(await store.recordFailure('f', 60_000, 2)).toEqual({ count: 2, lastAtMs: 2 });
    expect(await store.get('f')).toEqual({ count: 2, lastAtMs: 2 });
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
