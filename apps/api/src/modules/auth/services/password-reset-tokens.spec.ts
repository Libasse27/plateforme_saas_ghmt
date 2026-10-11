import { describe, expect, it, vi } from 'vitest';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { invalidatePasswordResetTokens } from './password-reset-tokens';

describe('invalidatePasswordResetTokens', () => {
  it('consomme les seuls jetons ouverts de l’utilisateur et en renvoie le nombre', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const tx = { passwordResetToken: { updateMany } } as unknown as TenantTx;
    const now = new Date('2026-10-06T08:00:00.000Z');

    expect(await invalidatePasswordResetTokens(tx, 't1', 'u1', now)).toBe(2);
    expect(updateMany).toHaveBeenCalledWith({ where: { tenantId: 't1', userId: 'u1', consumedAt: null }, data: { consumedAt: now } });
  });
});
