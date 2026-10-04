import { describe, expect, it, vi } from 'vitest';
import { DomainError } from '../../../common/errors/domain-error';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { assertAnotherActiveAdmin, holdsActiveAdminRole } from './admin-invariant';

const TENANT = '0198a000-0000-7000-8000-000000000001';

function fakeTx(rows: { userId: string }[]): { tx: TenantTx; findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn>; lock: ReturnType<typeof vi.fn> } {
  const findMany = vi.fn().mockResolvedValue(rows);
  const findFirst = vi.fn().mockResolvedValue(rows[0] ?? null);
  const lock = vi.fn().mockResolvedValue([]);
  const tx = { $queryRaw: lock, userRoleAssignment: { findMany, findFirst } } as unknown as TenantTx;
  return { tx, findMany, findFirst, lock };
}

describe('invariant : dernier administrateur actif', () => {
  it('verrouille le rôle tenant_admin puis accepte quand un autre administrateur actif existe', async () => {
    const { tx, lock } = fakeTx([{ userId: 'autre' }]);

    await expect(assertAnotherActiveAdmin(tx, TENANT, { excludeUserId: 'cible' })).resolves.toBeUndefined();

    expect(lock).toHaveBeenCalledTimes(1);
  });

  it('refuse avec last_admin (409) quand aucun autre administrateur actif ne subsiste', async () => {
    const { tx } = fakeTx([]);

    const result = assertAnotherActiveAdmin(tx, TENANT, { excludeUserId: 'cible' });

    await expect(result).rejects.toBeInstanceOf(DomainError);
    await expect(result).rejects.toMatchObject({ code: 'last_admin', status: 409 });
  });

  it('exclut l’utilisateur ou l’affectation visés de la recherche', async () => {
    const { tx, findMany } = fakeTx([{ userId: 'autre' }]);

    await assertAnotherActiveAdmin(tx, TENANT, { excludeUserId: 'u1', excludeAssignmentId: 'a1' });

    const where = findMany.mock.calls[0]![0].where;
    expect(where.userId).toEqual({ not: 'u1' });
    expect(where.id).toEqual({ not: 'a1' });
    expect(where.scopeType).toBe('tenant');
    expect(where.revokedAt).toBeNull();
    expect(where.user).toEqual({ status: 'active', deletedAt: null });
  });

  it('holdsActiveAdminRole détecte un administrateur actif', async () => {
    expect(await holdsActiveAdminRole(fakeTx([{ userId: 'x' }]).tx, 'x')).toBe(true);
    expect(await holdsActiveAdminRole(fakeTx([]).tx, 'x')).toBe(false);
  });
});
