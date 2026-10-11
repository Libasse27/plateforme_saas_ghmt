import { describe, expect, it } from 'vitest';
import { DIRECTOR_ROLE, isDirectorRole } from './director-role';

describe('isDirectorRole', () => {
  it('reconnaît le seul rôle système du modèle director', () => {
    expect(isDirectorRole({ isSystem: true, templateCode: 'director' })).toBe(true);
    expect(isDirectorRole({ ...DIRECTOR_ROLE })).toBe(true);
  });

  it('refuse un rôle personnalisé ou un autre modèle', () => {
    expect(isDirectorRole({ isSystem: false, templateCode: 'director' })).toBe(false);
    expect(isDirectorRole({ isSystem: true, templateCode: 'tenant_admin' })).toBe(false);
    expect(isDirectorRole({ isSystem: true, templateCode: null })).toBe(false);
  });
});
