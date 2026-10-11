import { describe, expect, it, vi } from 'vitest';
import { touchLastSeen } from './last-seen';

const NOW = new Date('2026-10-06T10:00:00.000Z');

function fakeTx(count: number) {
  const updateMany = vi.fn().mockResolvedValue({ count });
  return { tx: { user: { updateMany } } as never, updateMany };
}

describe('touchLastSeen', () => {
  it('écrit la date quand elle est absente ou plus ancienne de plus de 5 minutes', async () => {
    const { tx, updateMany } = fakeTx(1);

    const written = await touchLastSeen(tx, 't', 'u', NOW);

    expect(written).toBe(true);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        tenantId: 't',
        id: 'u',
        OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: new Date('2026-10-06T09:55:00.000Z') } }],
      },
      data: { lastSeenAt: NOW },
    });
  });

  it('ne signale aucune écriture quand la valeur est récente', async () => {
    const { tx } = fakeTx(0);
    expect(await touchLastSeen(tx, 't', 'u', NOW)).toBe(false);
  });
});
