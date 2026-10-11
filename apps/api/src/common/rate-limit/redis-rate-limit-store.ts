import type { Redis } from 'ioredis';
import type { AttemptGate, FailureRecord, RateLimitStore, WindowHit } from './rate-limit-store';

/**
 * Fenêtre fixe atomique : INCR + PEXPIRE à la première frappe, blocage au (limite + 1)-ième coup.
 * KEYS[1] = compteur, KEYS[2] = blocage ; ARGV = ttl, limite, durée de blocage (ms).
 * Retourne { frappes, ttl restant, bloqué (0/1), blocage restant }.
 */
const HIT_SCRIPT = `
local blockTtl = redis.call('PTTL', KEYS[2])
if blockTtl > 0 then
  local current = tonumber(redis.call('GET', KEYS[1]) or '0')
  local windowTtl = redis.call('PTTL', KEYS[1])
  if windowTtl < 0 then windowTtl = 0 end
  return { current, windowTtl, 1, blockTtl }
end
local limit = tonumber(ARGV[2])
local blockMs = tonumber(ARGV[3])
if blockMs <= 0 then
  local current = tonumber(redis.call('GET', KEYS[1]) or '0')
  if current >= limit then
    local windowTtl = redis.call('PTTL', KEYS[1])
    if windowTtl < 0 then windowTtl = 0 end
    return { current + 1, windowTtl, 1, windowTtl }
  end
end
local hits = redis.call('INCR', KEYS[1])
local windowTtl = redis.call('PTTL', KEYS[1])
if hits == 1 or windowTtl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  windowTtl = tonumber(ARGV[1])
end
if hits > limit then
  redis.call('SET', KEYS[2], '1', 'PX', blockMs)
  return { hits, windowTtl, 1, blockMs }
end
return { hits, windowTtl, 0, 0 }
`;

/** Compteur d'échecs : HINCRBY + date du dernier échec + expiration glissante. KEYS[1] = hash ; ARGV = ttl, maintenant (ms). */
const FAILURE_SCRIPT = `
local count = redis.call('HINCRBY', KEYS[1], 'count', 1)
redis.call('HSET', KEYS[1], 'last', ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[1])
return { count, tonumber(ARGV[2]) }
`;

/**
 * Admission atomique d'une tentative (délai progressif) : lit le compteur, applique le barème (plafonné si ARGV[3] ≥ 0), refuse
 * pendant le délai, sinon réserve la tentative. KEYS[1] = hash ; ARGV = ttl, maintenant (ms), plafond (s, −1 : aucun), n, barème…
 * Retourne { admise (0/1), attente restante (ms), compteur }.
 */
const GATE_SCRIPT = `
local count = tonumber(redis.call('HGET', KEYS[1], 'count') or '0')
local last = tonumber(redis.call('HGET', KEYS[1], 'last') or '0')
local ttl = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local cap = tonumber(ARGV[3])
local n = tonumber(ARGV[4])
if count > 0 and now - last > ttl then
  redis.call('DEL', KEYS[1])
  count = 0
end
if count > 0 then
  local delay = tonumber(ARGV[4 + math.min(count, n)])
  if cap >= 0 and delay > cap then delay = cap end
  local remaining = last + delay * 1000 - now
  if remaining > 0 then return { 0, remaining, count } end
end
if count > 0 then redis.call('HSET', KEYS[1], 'prev', last) else redis.call('HDEL', KEYS[1], 'prev') end
count = redis.call('HINCRBY', KEYS[1], 'count', 1)
redis.call('HSET', KEYS[1], 'last', ARGV[2])
redis.call('PEXPIRE', KEYS[1], ttl)
return { 1, 0, count }
`;

/** Retire un échec et restaure la date du dernier échec précédent ; supprime la clé quand il n'en reste plus. KEYS[1] = hash. */
const RELEASE_SCRIPT = `
local count = tonumber(redis.call('HGET', KEYS[1], 'count') or '0')
if count <= 1 then
  redis.call('DEL', KEYS[1])
  return 1
end
redis.call('HINCRBY', KEYS[1], 'count', -1)
local prev = redis.call('HGET', KEYS[1], 'prev')
if prev then
  redis.call('HSET', KEYS[1], 'last', prev)
  redis.call('HDEL', KEYS[1], 'prev')
end
return 1
`;

type ScriptNumbers = readonly [number, number, number, number];

/** Stockage partagé entre instances. Clés : `<préfixe><limiteur>:<traceur>` (+ suffixes `:block` et `:fail`). */
export class RedisRateLimitStore implements RateLimitStore {
  constructor(
    private readonly client: Redis,
    private readonly keyPrefix: string,
  ) {}

  async hit(key: string, ttlMs: number, limit: number, blockMs: number): Promise<WindowHit> {
    const counter = this.keyPrefix + key;
    const raw = (await this.client.eval(HIT_SCRIPT, 2, counter, `${counter}:block`, ttlMs, limit, blockMs)) as ScriptNumbers;
    const [totalHits, windowTtl, blocked, blockTtl] = raw;
    return { totalHits, timeToExpireMs: windowTtl, isBlocked: blocked === 1, timeToBlockExpireMs: blockTtl };
  }

  async recordFailure(key: string, ttlMs: number, nowMs: number): Promise<FailureRecord> {
    const raw = (await this.client.eval(FAILURE_SCRIPT, 1, `${this.keyPrefix}${key}:fail`, ttlMs, nowMs)) as readonly [number, number];
    return { count: raw[0], lastAtMs: raw[1] };
  }

  async gate(key: string, ttlMs: number, nowMs: number, scheduleSeconds: readonly number[], capSeconds: number | null): Promise<AttemptGate> {
    const raw = (await this.client.eval(GATE_SCRIPT, 1, `${this.keyPrefix}${key}:fail`, ttlMs, nowMs, capSeconds ?? -1, scheduleSeconds.length, ...scheduleSeconds)) as readonly [number, number, number];
    return { allowed: raw[0] === 1, retryAfterMs: raw[1], count: raw[2] };
  }

  async release(key: string): Promise<void> {
    await this.client.eval(RELEASE_SCRIPT, 1, `${this.keyPrefix}${key}:fail`);
  }

  async get(key: string): Promise<FailureRecord | null> {
    const fields = await this.client.hgetall(`${this.keyPrefix}${key}:fail`);
    if (!fields['count']) return null;
    return { count: Number(fields['count']), lastAtMs: Number(fields['last'] ?? 0) };
  }

  async reset(key: string): Promise<void> {
    const counter = this.keyPrefix + key;
    await this.client.del(counter, `${counter}:block`, `${counter}:fail`);
  }
}
