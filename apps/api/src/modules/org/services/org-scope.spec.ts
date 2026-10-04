import { describe, expect, it } from 'vitest';
import type { EffectiveGrant } from '../../../common/authz/authorization.types';
import { diffChanges, canAccessDepartment, canAccessSite, departmentScopeWhere, siteScopeWhere } from './org-scope';

const SITE_A = 'a0000000-0000-7000-8000-00000000000a';
const SITE_B = 'b0000000-0000-7000-8000-00000000000b';
const DEPT = 'd0000000-0000-7000-8000-0000000000d1';

const grant = (scopeType: EffectiveGrant['scopeType'], scopeId: string | null): EffectiveGrant => ({
  permission: 'org:site:read',
  scopeType,
  scopeId,
  mfaRequired: false,
});

const scopesOf = (...grants: EffectiveGrant[]) => ({
  allTenant: grants.some((g) => g.scopeType === 'tenant'),
  siteIds: grants.filter((g) => g.scopeType === 'site').map((g) => g.scopeId!),
  departmentIds: grants.filter((g) => g.scopeType === 'department').map((g) => g.scopeId!),
});

describe('org-scope : filtrage par portée', () => {
  it('ne filtre pas les sites pour une portée établissement', () => {
    expect(siteScopeWhere(scopesOf(grant('tenant', null)))).toEqual({});
  });

  it('limite les sites à ceux de la portée', () => {
    expect(siteScopeWhere(scopesOf(grant('site', SITE_A)))).toEqual({ id: { in: [SITE_A] } });
  });

  it('ne renvoie aucun site pour une portée uniquement service', () => {
    expect(siteScopeWhere(scopesOf(grant('department', DEPT)))).toEqual({ id: { in: [] } });
  });

  it('limite les services aux sites et services de la portée', () => {
    const where = departmentScopeWhere(scopesOf(grant('site', SITE_A), grant('department', DEPT)));
    expect(where).toEqual({ OR: [{ siteId: { in: [SITE_A] } }, { id: { in: [DEPT] } }] });
  });

  it('canAccessSite : tenant, site listé, site non listé', () => {
    expect(canAccessSite(scopesOf(grant('tenant', null)), SITE_B)).toBe(true);
    expect(canAccessSite(scopesOf(grant('site', SITE_A)), SITE_A)).toBe(true);
    expect(canAccessSite(scopesOf(grant('site', SITE_A)), SITE_B)).toBe(false);
  });

  it('canAccessDepartment : via le site ou via le service lui-même', () => {
    expect(canAccessDepartment(scopesOf(grant('site', SITE_A)), { id: DEPT, siteId: SITE_A })).toBe(true);
    expect(canAccessDepartment(scopesOf(grant('department', DEPT)), { id: DEPT, siteId: SITE_B })).toBe(true);
    expect(canAccessDepartment(scopesOf(grant('site', SITE_B)), { id: DEPT, siteId: SITE_A })).toBe(false);
  });
});

describe('org-scope : diffChanges', () => {
  it('ne conserve que les champs réellement modifiés', () => {
    const result = diffChanges({ name: 'Ancien', city: 'Dakar' }, { name: 'Nouveau', city: 'Dakar' });
    expect(result).toEqual({ before: { name: 'Ancien' }, after: { name: 'Nouveau' } });
  });

  it('ignore les champs non fournis (undefined)', () => {
    expect(diffChanges({ name: 'A', city: 'B' }, { name: undefined })).toEqual({ before: {}, after: {} });
  });
});
