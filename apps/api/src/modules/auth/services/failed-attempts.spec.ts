import { describe, expect, it, vi } from 'vitest';
import { clearFailedAttempts, registerFailedAttempt } from './failed-attempts';

function fakeTx(newCount: number) {
  const update = vi.fn().mockResolvedValue({ failedAttempts: newCount });
  return { tx: { userCredential: { update } } as never, update };
}

describe('registerFailedAttempt', () => {
  it('incrémente atomiquement le compteur et renvoie sa nouvelle valeur, sans jamais poser de verrou', async () => {
    const { tx, update } = fakeTx(5);

    const count = await registerFailedAttempt(tx, 't', 'u');

    expect(count).toBe(5);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId_userId: { tenantId: 't', userId: 'u' } }, data: { failedAttempts: { increment: 1 } } }),
    );
  });
});

describe('clearFailedAttempts', () => {
  it('remet le compteur à zéro sans toucher à locked_until (colonne obsolète)', async () => {
    const { tx, update } = fakeTx(0);

    await clearFailedAttempts(tx, 't', 'u');

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ data: { failedAttempts: 0 } }));
  });
});
