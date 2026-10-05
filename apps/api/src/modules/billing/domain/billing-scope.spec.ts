import { describe, expect, it } from 'vitest';
import type { EffectiveGrant } from '../../../common/authz/authorization.types';
import { buildSiteScopeFilter, holdsPermission, isSiteInScope } from './billing-scope';

const SITE_A = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a01';
const SITE_B = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a02';
const SITE_C = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a03';

const grant = (permission: EffectiveGrant['permission'], scopeType: EffectiveGrant['scopeType'], scopeId: string | null): EffectiveGrant => ({
  permission,
  scopeType,
  scopeId,
  mfaRequired: false,
});

describe('périmètre des factures et de la caisse', () => {
  it('portée établissement : aucun filtre, tout site couvert', () => {
    const scope = { allTenant: true, siteIds: [], departmentIds: [] };

    expect(buildSiteScopeFilter(scope, [])).toEqual({});
    expect(isSiteInScope(scope, SITE_A, [])).toBe(true);
  });

  it('portée site : filtre sur les sites autorisés, y compris ceux des services de la portée', () => {
    const scope = { allTenant: false, siteIds: [SITE_A], departmentIds: ['d1'] };

    expect(buildSiteScopeFilter(scope, [SITE_B])).toEqual({ siteId: { in: [SITE_A, SITE_B] } });
    expect(isSiteInScope(scope, SITE_A, [SITE_B])).toBe(true);
    expect(isSiteInScope(scope, SITE_B, [SITE_B])).toBe(true);
    expect(isSiteInScope(scope, SITE_C, [SITE_B])).toBe(false);
  });

  it('permission non détenue : filtre vide qui ne renvoie rien', () => {
    const scope = { allTenant: false, siteIds: [], departmentIds: [] };

    expect(buildSiteScopeFilter(scope, [])).toEqual({ siteId: { in: [] } });
    expect(isSiteInScope(scope, SITE_A, [])).toBe(false);
  });

  it('holdsPermission détecte une permission quelle que soit sa portée', () => {
    const grants = [grant('billing:invoice:update', 'site', SITE_A)];

    expect(holdsPermission('billing:invoice:update', grants)).toBe(true);
    expect(holdsPermission('billing:invoice:validate', grants)).toBe(false);
  });
});
