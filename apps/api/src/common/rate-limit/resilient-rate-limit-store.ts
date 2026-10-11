import type { AttemptGate, FailureRecord, RateLimitStore, WindowHit } from './rate-limit-store';

/** Pause avant de réessayer le stockage principal : évite d'attendre le délai d'expiration à chaque requête. */
const RETRY_PRIMARY_AFTER_MS = 5_000;
/** Repli prudent (docs/11 décision 24) : attente annoncée à un identifiant refusé pendant la panne. */
export const PRUDENT_RETRY_AFTER_MS = 60_000;
/** Repli prudent : admissions examinées par minute et par instance pendant la panne, tous identifiants confondus. */
export const PRUDENT_ADMISSIONS_PER_MINUTE = 60;
const PRUDENT_WINDOW_MS = 60_000;
const PRUDENT_ADMISSIONS_KEY = 'prudent-fallback:admissions';
export interface ResilientOptions {
  readonly now?: () => number;
  /** Appelé une fois à l'entrée en mode dégradé (nom de l'erreur seulement : aucune donnée sensible). */
  readonly onDegraded?: (reason: string) => void;
  /** Appelé une fois au retour du stockage principal, avec la durée du mode dégradé. */
  readonly onRecovered?: (degradedForMs: number) => void;
}

/**
 * Stockage principal (Redis) avec repli mémoire par instance : la limitation n'est jamais absente (docs/04 §9.3),
 * même si elle n'est plus partagée entre instances pendant la panne. Les admissions (`gate`) passent alors en repli
 * prudent (décision 24) : un identifiant déjà en échec pendant la panne est refusé et l'instance plafonne ses admissions,
 * pour qu'un attaquant ne multiplie pas ses essais en répartissant ses requêtes entre instances.
 */
export class ResilientRateLimitStore implements RateLimitStore {
  private pausedUntil = 0;
  /** Date d'entrée en mode dégradé ; `null` tant que le stockage principal répond. */
  private degradedSince: number | null = null;
  /** Identifiants admis pendant la panne en cours : seul un échec de cette période vaut refus prudent. */
  private degradedKeys = new Set<string>();
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

  gate(key: string, ttlMs: number, nowMs: number, scheduleSeconds: readonly number[], capSeconds: number | null): Promise<AttemptGate> {
    return this.run(
      (store) => store.gate(key, ttlMs, nowMs, scheduleSeconds, capSeconds),
      () => this.prudentGate(key, ttlMs, nowMs, scheduleSeconds, capSeconds),
    );
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

  private async run<T>(operation: (store: RateLimitStore) => Promise<T>, onFallback: () => Promise<T> = () => operation(this.fallback)): Promise<T> {
    // Pendant la pause qui suit un échec, le stockage principal n'est pas sollicité.
    if (this.now() < this.pausedUntil) return onFallback();
    let result: T;
    try {
      result = await operation(this.primary);
    } catch (error: unknown) {
      this.degrade(error);
      return onFallback();
    }
    this.recover();
    return result;
  }

  private async prudentGate(key: string, ttlMs: number, nowMs: number, scheduleSeconds: readonly number[], capSeconds: number | null): Promise<AttemptGate> {
    const current = this.degradedKeys.has(key) ? await this.fallback.get(key) : null;
    if (current && current.count > 0) return { allowed: false, retryAfterMs: PRUDENT_RETRY_AFTER_MS, count: current.count };
    const budget = await this.fallback.hit(PRUDENT_ADMISSIONS_KEY, PRUDENT_WINDOW_MS, PRUDENT_ADMISSIONS_PER_MINUTE, 0);
    if (budget.isBlocked) return { allowed: false, retryAfterMs: Math.max(1, budget.timeToBlockExpireMs), count: current?.count ?? 0 };
    const gate = await this.fallback.gate(key, ttlMs, nowMs, scheduleSeconds, capSeconds);
    if (gate.allowed) this.degradedKeys.add(key);
    return gate;
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
    this.degradedKeys = new Set();
    this.options.onRecovered?.(degradedForMs);
  }
}
