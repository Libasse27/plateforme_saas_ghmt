import { createHash } from 'node:crypto';
import type { NotificationChannel } from '@ghmt/shared';

const SECOND_MS = 1_000;
const HOUR_MS = 3_600_000;
const JITTER_SPREAD = 0.1;

interface ChannelPolicy {
  readonly maxAttempts: number;
  readonly baseMs: number;
  readonly capMs: number | null;
}

/** Tentatives et backoff par canal (docs/10 §5.8) : SMS 5 × 30 s, e-mail 6 × 60 s plafonné à 6 h, in-app 1. */
export const RETRY_POLICY: Readonly<Record<NotificationChannel, ChannelPolicy>> = {
  sms: { maxAttempts: 5, baseMs: 30 * SECOND_MS, capMs: null },
  email: { maxAttempts: 6, baseMs: 60 * SECOND_MS, capMs: 6 * HOUR_MS },
  inapp: { maxAttempts: 1, baseMs: 0, capMs: null },
};

/** Facteur déterministe dans [0,9 ; 1,1] dérivé de la notification et de la tentative. */
function jitterFactor(seed: string, attempt: number): number {
  const unit = createHash('sha256').update(`${seed}:${attempt}`).digest().readUInt32BE(0) / 2 ** 32;
  return 1 - JITTER_SPREAD + 2 * JITTER_SPREAD * unit;
}

/** Délai avant la tentative suivante, `attempt` étant le nombre d'échecs déjà subis (base × 2^(n-1), ±10 %). */
export function backoffMs(channel: NotificationChannel, attempt: number, seed: string): number {
  const policy = RETRY_POLICY[channel];
  const raw = policy.baseMs * 2 ** (attempt - 1);
  const capped = policy.capMs === null ? raw : Math.min(raw, policy.capMs);
  return Math.round(capped * jitterFactor(seed, attempt));
}

export type FailureDecision =
  | { readonly kind: 'retry'; readonly nextAttemptAt: Date }
  | { readonly kind: 'fail'; readonly errorCode: 'max_attempts' | 'deadline_exceeded' };

export interface FailureContext {
  readonly channel: NotificationChannel;
  /** Tentatives effectuées, l'échec courant compris. */
  readonly attempts: number;
  readonly now: Date;
  readonly deadlineAt: Date | null;
  readonly seed: string;
}

/** Suite d'une erreur transitoire : nouvel essai, ou échec définitif (nombre maximal atteint, échéance dépassée). */
export function decideAfterFailure(context: FailureContext): FailureDecision {
  if (context.attempts >= RETRY_POLICY[context.channel].maxAttempts) return { kind: 'fail', errorCode: 'max_attempts' };
  const nextAttemptAt = new Date(context.now.getTime() + backoffMs(context.channel, context.attempts, context.seed));
  if (context.deadlineAt !== null && nextAttemptAt > context.deadlineAt) return { kind: 'fail', errorCode: 'deadline_exceeded' };
  return { kind: 'retry', nextAttemptAt };
}
