import { describe, expect, it } from 'vitest';
import { adminRank, assertCanEditRolePermissions, assertCanGrantRole, assertCanManage } from './admin-hierarchy';

describe('adminRank', () => {
  it('donne 2 au principal quelles que soient ses permissions', () => {
    expect(adminRank({ isOwner: true, permissions: [] })).toBe(2);
    expect(adminRank({ isOwner: true, permissions: ['iam:user:update'] })).toBe(2);
  });

  it('donne 1 à qui détient une permission d’administration en écriture', () => {
    expect(adminRank({ isOwner: false, permissions: ['iam:user:update'] })).toBe(1);
    expect(adminRank({ isOwner: false, permissions: ['patients:patient:read', 'iam:role:create'] })).toBe(1);
  });

  it('donne 0 aux autres, y compris en lecture IAM seule', () => {
    expect(adminRank({ isOwner: false, permissions: ['iam:user:read', 'iam:role:read'] })).toBe(0);
    expect(adminRank({ isOwner: false, permissions: ['consultations:consultation:read'] })).toBe(0);
    expect(adminRank({ isOwner: false, permissions: [] })).toBe(0);
  });
});

describe('assertCanManage', () => {
  const actor = (rank: 0 | 1 | 2) => ({ userId: 'a', rank });
  const target = (rank: 0 | 1 | 2) => ({ userId: 't', rank });

  it.each([
    [0, 0],
    [1, 0],
    [2, 0],
    [2, 1],
    [2, 2],
  ] as const)('autorise un acteur de rang %i sur une cible de rang %i quand c’est permis', (a, t) => {
    if (t >= 1 && a <= t) expect(() => assertCanManage(actor(a), target(t))).toThrowError(/administrateur principal/);
    else expect(() => assertCanManage(actor(a), target(t))).not.toThrow();
  });

  it('refuse un administrateur non principal sur un autre administrateur (403 admin_hierarchy)', () => {
    expect(() => assertCanManage(actor(1), target(1))).toThrowError(expect.objectContaining({ code: 'admin_hierarchy', status: 403 }));
    expect(() => assertCanManage(actor(1), target(2))).toThrowError(expect.objectContaining({ code: 'admin_hierarchy' }));
  });

  it('refuse deux principaux entre eux seulement si le rang n’est pas strictement supérieur', () => {
    expect(() => assertCanManage(actor(2), target(2))).toThrowError(expect.objectContaining({ code: 'admin_hierarchy' }));
  });

  it('laisse chacun agir sur lui-même', () => {
    expect(() => assertCanManage({ userId: 'x', rank: 1 }, { userId: 'x', rank: 1 })).not.toThrow();
    expect(() => assertCanManage({ userId: 'x', rank: 2 }, { userId: 'x', rank: 2 })).not.toThrow();
  });
});

describe('assertCanGrantRole', () => {
  it('réserve les rôles d’administration en écriture au principal (403 owner_required)', () => {
    expect(() => assertCanGrantRole(1, ['iam:user:update'])).toThrowError(expect.objectContaining({ code: 'owner_required', status: 403 }));
    expect(() => assertCanGrantRole(0, ['iam:*'])).toThrowError(expect.objectContaining({ code: 'owner_required' }));
    expect(() => assertCanGrantRole(2, ['iam:user:update'])).not.toThrow();
  });

  it('laisse tout administrateur accorder un rôle sans écriture IAM', () => {
    expect(() => assertCanGrantRole(1, ['consultations:consultation:read', 'iam:user:read'])).not.toThrow();
    expect(() => assertCanGrantRole(0, [])).not.toThrow();
  });
});

describe('assertCanEditRolePermissions (H3, docs/11 §14.1)', () => {
  const codeOf = (fn: () => void): string | null => {
    try {
      fn();
      return null;
    } catch (error: unknown) {
      return (error as { code?: string }).code ?? 'autre';
    }
  };

  it('refuse à un non-principal l’ajout d’une permission d’administration en écriture à un rôle affecté', () => {
    const change = { assigned: true, before: ['org:site:read'], after: ['org:site:read', 'iam:user:update'] };
    expect(codeOf(() => assertCanEditRolePermissions(1, change))).toBe('owner_required');
    expect(codeOf(() => assertCanEditRolePermissions(0, change))).toBe('owner_required');
    expect(codeOf(() => assertCanEditRolePermissions(2, change))).toBeNull();
  });

  it('refuse à un non-principal la création d’un rôle portant une permission d’administration en écriture', () => {
    const creation = { isNew: true, assigned: false, before: [], after: ['iam:role:create'] };
    expect(codeOf(() => assertCanEditRolePermissions(1, creation))).toBe('owner_required');
    expect(codeOf(() => assertCanEditRolePermissions(2, creation))).toBeNull();
  });

  it('laisse un non-principal modifier un rôle sans ajout de droit d’administration en écriture', () => {
    expect(codeOf(() => assertCanEditRolePermissions(1, { assigned: true, before: ['iam:user:update'], after: ['iam:user:update', 'org:site:read'] }))).toBeNull();
    expect(codeOf(() => assertCanEditRolePermissions(1, { assigned: true, before: ['org:site:read'], after: ['org:site:read', 'iam:user:read'] }))).toBeNull();
    expect(codeOf(() => assertCanEditRolePermissions(1, { assigned: true, before: ['iam:user:update'], after: [] }))).toBeNull();
  });

  it('un rôle existant non affecté reste modifiable par un non-principal (aucun titulaire n’est promu)', () => {
    expect(codeOf(() => assertCanEditRolePermissions(1, { assigned: false, before: ['org:site:read'], after: ['iam:user:update'] }))).toBeNull();
  });
});
