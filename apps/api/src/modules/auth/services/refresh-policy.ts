import { REFRESH_GRACE_WINDOW_MS } from '../auth.constants';

export const GRACE_WINDOW_MS = REFRESH_GRACE_WINDOW_MS;

export interface RefreshSnapshot {
  readonly tokenUsedAt: Date | null;
  readonly tokenExpiresAt: Date;
  /** `undefined` : remplaçant introuvable ; `null` : remplaçant jamais utilisé. */
  readonly replacementUsedAt: Date | null | undefined;
  readonly sessionRevokedAt: Date | null;
  readonly sessionExpiresAt: Date;
}

export type RefreshDecision = 'rotate' | 'grace' | 'reuse' | 'invalid';

/**
 * Décision pure de rotation (docs/04 §1.4) :
 * - session morte ou jeton expiré ⇒ invalid ;
 * - jeton déjà consommé : rejeu < 10 s dont le remplaçant n'a pas servi ⇒ grace, sinon reuse (vol présumé).
 */
export function evaluateRefresh(snapshot: RefreshSnapshot, now: Date): RefreshDecision {
  if (snapshot.sessionRevokedAt || snapshot.sessionExpiresAt <= now) return 'invalid';
  if (snapshot.tokenUsedAt) {
    const withinGrace = now.getTime() - snapshot.tokenUsedAt.getTime() <= GRACE_WINDOW_MS;
    return withinGrace && snapshot.replacementUsedAt === null ? 'grace' : 'reuse';
  }
  if (snapshot.tokenExpiresAt <= now) return 'invalid';
  return 'rotate';
}
