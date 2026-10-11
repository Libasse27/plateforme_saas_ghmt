import type { AttemptGate, FailureRecord, RateLimitStore, WindowHit } from './rate-limit-store';

/** Pause avant de réessayer le stockage principal : évite d'attendre le délai d'expiration à chaque requête. */
const RETRY_PRIMARY_AFTER_MS = 5_000;
export interface ResilientOptions {
  readonly now?: () => number;
  /** Appelé une fois à l'entrée en mode dégradé (nom de l'erreur seulement : aucune donnée sensible). */
  readonly onDegraded?: (reason: string) => void;
  /** Appelé une fois au retour du stockage principal, avec la durée du mode dégradé. */
  readonly onRecovered?: (degradedForMs: number) => void;
}

/**
 * Stockage principal (Redis) avec repli mémoire par instance : la limitation n'est jamais absente (docs/04 §9.3),
 * même si elle n'est plus partagée entre instances pendant la panne.
 */
export class ResilientRateLimitStore implements RateLimitStore {
  private pausedUntil = 0;
  /** Date d'entrée en mode dégradé ; `null` tant que le stockage principal répond. */
  private degradedSince: number | null = null;
  private readonly now: () => number;

  constructor(
    private readonly primary: RateLimitStore,
    private readonly fallback: RateLimitStore,
    private readonly options: ResilientOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Vrai depuis un échec du stockage principal jusqu'à sa prochaine réponse : la limitation est alors en mémoire, non
   * partagée entre instances (exposé par `/health/ready`).
   */
  isDegraded(): boolean {
    return this.degradedSince !== null;
  }

  hit(key: string, ttlMs: number, limit: number, blockMs: number): Promise<WindowHit> {
    return this.run((store) => store.hit(key, ttlMs, limit, blockMs));
  }

  recordFailure(key: string, ttlMs: number, nowMs: number): Promise<FailureRecord> {
    return this.run((store) => store.recordFailure(key, ttlMs, nowMs));
  }

  gate(key: string, ttlMs: number, nowMs: number, scheduleSeconds: readonly number[], capSeconds: number | null): Promise<AttemptGate> {
    return this.run((store) => store.gate(key, ttlMs, nowMs, scheduleSeconds, capSeconds));
  }

  async release(key: string): Promise<void> {
    await this.run((store) => store.release(key));
  }

  get(key: string): Promise<FailureRecord | null> {
    return this.run((store) => store.get(key));
  }

  async reset(key: string): Promise<void> {
    // Les deux stockages sont vidés : une écriture faite en repli ne doit pas survivre à la remise à zéro.
    await this.fallback.reset(key);
    await this.run((store) => store.reset(key));
  }

  private async run<T>(operation: (store: RateLimitStore) => Promise<T>): Promise<T> {
    // Pendant la pause qui suit un échec, le stockage principal n'est pas sollicité.
    if (this.now() < this.pausedUntil) return operation(this.fallback);
    let result: T;
    try {
      result = await operation(this.primary);
    } catch (error: unknown) {
      this.degrade(error);
      return operation(this.fallback);
    }
    this.recover();
    return result;
  }

  private degrade(error: unknown): void {
    const now = this.now();
    this.pausedUntil = now + RETRY_PRIMARY_AFTER_MS;
    if (this.degradedSince !== null) return;
    this.degradedSince = now;
    // Seul le nom de l'erreur est transmis : le message d'ioredis peut citer l'URL (et ses identifiants).
    this.options.onDegraded?.(error instanceof Error ? error.name : 'unknown');
  }

  private recover(): void {
    if (this.degradedSince === null) return;
    const degradedForMs = this.now() - this.degradedSince;
    this.degradedSince = null;
    this.options.onRecovered?.(degradedForMs);
  }
}
