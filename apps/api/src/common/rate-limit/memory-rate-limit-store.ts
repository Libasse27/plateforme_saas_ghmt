import type { AttemptGate, FailureRecord, RateLimitStore, WindowHit } from './rate-limit-store';

interface WindowEntry {
  readonly hits: number;
  readonly windowEndsAt: number;
  readonly blockedUntil: number;
}

interface FailureEntry extends FailureRecord {
  readonly expiresAt: number;
  /** Date du dernier échec avant la dernière réservation de `gate` : restaurée par `release`. */
  readonly previousLastAtMs?: number;
}

const SWEEP_EVERY_OPERATIONS = 1_000;

/** Stockage en mémoire du processus : repli de `ResilientRateLimitStore` et mode de test (fenêtres fixes). Les entrées sont remplacées, jamais modifiées. */
export class MemoryRateLimitStore implements RateLimitStore {
  private windows = new Map<string, WindowEntry>();
  private failures = new Map<string, FailureEntry>();
  private operations = 0;

  constructor(private readonly now: () => number = Date.now) {}

  hit(key: string, ttlMs: number, limit: number, blockMs: number): Promise<WindowHit> {
    this.sweepOccasionally();
    const now = this.now();
    const current = this.windows.get(key);
    if (current && current.blockedUntil > now) return Promise.resolve(this.refusal(current, now));

    const open = current && current.windowEndsAt > now ? current : { hits: 0, windowEndsAt: now + ttlMs, blockedUntil: 0 };
    if (blockMs <= 0 && open.hits >= limit) return Promise.resolve(this.refusal(open, now, open.hits + 1));

    const hits = open.hits + 1;
    const exceeded = hits > limit;
    const entry: WindowEntry = { hits, windowEndsAt: open.windowEndsAt, blockedUntil: exceeded ? now + blockMs : 0 };
    this.windows.set(key, entry);
    return Promise.resolve(exceeded ? this.refusal(entry, now) : { totalHits: hits, timeToExpireMs: entry.windowEndsAt - now, isBlocked: false, timeToBlockExpireMs: 0 });
  }

  gate(key: string, ttlMs: number, nowMs: number, scheduleSeconds: readonly number[], capSeconds: number | null): Promise<AttemptGate> {
    this.sweepOccasionally();
    const stored = this.failures.get(key);
    const alive = stored && stored.expiresAt > this.now() && nowMs - stored.lastAtMs <= ttlMs ? stored : undefined;
    const count = alive?.count ?? 0;
    if (alive && count > 0) {
      const base = scheduleSeconds[Math.min(count, scheduleSeconds.length) - 1] ?? 0;
      const delaySeconds = capSeconds === null ? base : Math.min(base, capSeconds);
      const retryAfterMs = alive.lastAtMs + delaySeconds * 1_000 - nowMs;
      if (retryAfterMs > 0) return Promise.resolve({ allowed: false, retryAfterMs, count });
    }
    this.failures.set(key, { count: count + 1, lastAtMs: nowMs, expiresAt: this.now() + ttlMs, ...(alive ? { previousLastAtMs: alive.lastAtMs } : {}) });
    return Promise.resolve({ allowed: true, retryAfterMs: 0, count: count + 1 });
  }

  release(key: string): Promise<void> {
    const entry = this.failures.get(key);
    if (!entry) return Promise.resolve();
    if (entry.count <= 1) this.failures.delete(key);
    else this.failures.set(key, { count: entry.count - 1, lastAtMs: entry.previousLastAtMs ?? entry.lastAtMs, expiresAt: entry.expiresAt });
    return Promise.resolve();
  }

  get(key: string): Promise<FailureRecord | null> {
    const entry = this.failures.get(key);
    if (!entry || entry.expiresAt <= this.now()) return Promise.resolve(null);
    return Promise.resolve({ count: entry.count, lastAtMs: entry.lastAtMs });
  }

  reset(key: string): Promise<void> {
    this.windows.delete(key);
    this.failures.delete(key);
    return Promise.resolve();
  }

  private refusal(entry: WindowEntry, now: number, totalHits = entry.hits): WindowHit {
    const blockRemaining = Math.max(0, entry.blockedUntil - now);
    return {
      totalHits,
      timeToExpireMs: Math.max(0, entry.windowEndsAt - now),
      isBlocked: true,
      timeToBlockExpireMs: blockRemaining > 0 ? blockRemaining : Math.max(0, entry.windowEndsAt - now),
    };
  }

  /** Purge paresseuse : aucune minuterie, donc rien à arrêter à la fermeture de l'application. */
  private sweepOccasionally(): void {
    this.operations += 1;
    if (this.operations % SWEEP_EVERY_OPERATIONS !== 0) return;
    const now = this.now();
    this.windows = new Map([...this.windows].filter(([, entry]) => entry.windowEndsAt > now || entry.blockedUntil > now));
    this.failures = new Map([...this.failures].filter(([, entry]) => entry.expiresAt > now));
  }
}
