import { describe, expect, it } from 'vitest';
import { denial } from './permission.guard';

describe('denial (refus du PermissionGuard)', () => {
  it('mfa_enrollment_required porte offNetwork dans les membres du problème (docs/11 §14.1)', () => {
    expect(denial({ allowed: false, reason: 'mfa_enrollment_required', offNetwork: true }).extras).toMatchObject({ offNetwork: true });
    expect(denial({ allowed: false, reason: 'mfa_enrollment_required', offNetwork: false }).extras).toMatchObject({ offNetwork: false });
    // Rôle `mfaRequired` : le refus ne dépend pas du réseau.
    expect(denial({ allowed: false, reason: 'mfa_enrollment_required' }).extras).toMatchObject({ offNetwork: false });
  });

  it('les autres refus ne portent pas offNetwork et gardent la permission manquante', () => {
    const error = denial({ allowed: false, reason: 'permission_denied', permission: 'iam:user:read' });

    expect(error.status).toBe(403);
    expect(error.code).toBe('permission_denied');
    expect(error.extras).toEqual({ requiredPermission: 'iam:user:read' });
  });
});
