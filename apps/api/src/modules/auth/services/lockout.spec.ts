import { describe, expect, it, vi } from 'vitest';
import { lockoutAfter, registerFailedAttempt, clearFailedAttempts } from './lockout';

const NOW = new Date('2026-10-04T10:00:00.000Z');
const minutes = (n: number): Date => new Date(NOW.getTime() + n * 60_000);

describe('lockoutAfter', () => {
  it.each([1, 2, 3, 4])('ne verrouille pas avant 5 échecs (%i)', (attempts) => {
    expect(lockoutAfter(attempts, NOW)).toBeNull();
  });

  it.each([
    [5, 1],
    [10, 5],
    [15, 15],
    [20, 60],
    [25, 60],
    [100, 60],
  ])('verrouille à %i échecs pour %i minute(s), plafonné à 60', (attempts, duration) => {
    expect(lockoutAfter(attempts, NOW)).toEqual(minutes(duration));
  });

  it('ne verrouille pas entre deux paliers de 5', () => {
    expect(lockoutAfter(6, NOW)).toBeNull();
    expect(lockoutAfter(9, NOW)).toBeNull();
  });
});

describe('registerFailedAttempt / clearFailedAttempts', () => {
  function fakeTx(newCount: number) {
    const update = vi.fn().mockResolvedValueOnce({ failedAttempts: newCount }).mockResolvedValue({});
    return { tx: { userCredential: { update } } as never, update };
  }

  it('incrémente atomiquement puis pose le verrou au palier', async () => {
    const { tx, update } = fakeTx(5);

    const lockedUntil = await registerFailedAttempt(tx, 't', 'u', NOW);

    expect(update).toHaveBeenNthCalledWith(1, expect.objectContaining({ data: { failedAttempts: { increment: 1 } } }));
    expect(update).toHaveBeenNthCalledWith(2, expect.objectContaining({ data: { lockedUntil: minutes(1) } }));
    expect(lockedUntil).toEqual(minutes(1));
  });

  it('ne pose pas de verrou hors palier', async () => {
    const { tx, update } = fakeTx(3);

    const lockedUntil = await registerFailedAttempt(tx, 't', 'u', NOW);

    expect(lockedUntil).toBeNull();
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('remet le compteur et le verrou à zéro', async () => {
    const { tx, update } = fakeTx(0);

    await clearFailedAttempts(tx, 't', 'u');

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { failedAttempts: 0, lockedUntil: null } }));
  });
});
