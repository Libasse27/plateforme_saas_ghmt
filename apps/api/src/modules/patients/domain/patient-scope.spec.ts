import { describe, expect, it } from 'vitest';
import { buildPatientScopeFilter, isPatientWithinScope, isSiteWithinPatientScope } from './patient-scope';

const SITE_A = '0198a000-0000-7000-8000-00000000000a';
const SITE_B = '0198a000-0000-7000-8000-00000000000b';

describe('buildPatientScopeFilter (A6)', () => {
  it('n’applique aucun filtre pour la portée établissement', () => {
    expect(buildPatientScopeFilter({ allTenant: true, siteIds: [], departmentIds: [] }, [])).toEqual({});
  });

  it('limite aux sites de la portée et conserve les patients sans site principal', () => {
    expect(buildPatientScopeFilter({ allTenant: false, siteIds: [SITE_A], departmentIds: [] }, [])).toEqual({
      OR: [{ primarySiteId: null }, { primarySiteId: { in: [SITE_A] } }],
    });
  });

  it('ajoute le site des services de la portée sans doublon', () => {
    const filter = buildPatientScopeFilter({ allTenant: false, siteIds: [SITE_A], departmentIds: ['d1'] }, [SITE_B, SITE_A]);
    expect(filter).toEqual({ OR: [{ primarySiteId: null }, { primarySiteId: { in: [SITE_A, SITE_B] } }] });
  });

  it('ne voit que des patients sans site quand la portée est vide', () => {
    expect(buildPatientScopeFilter({ allTenant: false, siteIds: [], departmentIds: [] }, [])).toEqual({
      OR: [{ primarySiteId: null }, { primarySiteId: { in: [] } }],
    });
  });
});

describe('isSiteWithinPatientScope', () => {
  it('couvre tout site pour la portée établissement, sinon seulement les sites de la portée', () => {
    expect(isSiteWithinPatientScope({ allTenant: true, siteIds: [], departmentIds: [] }, SITE_B, [])).toBe(true);
    expect(isSiteWithinPatientScope({ allTenant: false, siteIds: [SITE_A], departmentIds: [] }, SITE_A, [])).toBe(true);
    expect(isSiteWithinPatientScope({ allTenant: false, siteIds: [SITE_A], departmentIds: [] }, SITE_B, [])).toBe(false);
    expect(isSiteWithinPatientScope({ allTenant: false, siteIds: [], departmentIds: ['d1'] }, SITE_B, [SITE_B])).toBe(true);
  });
});

describe('isPatientWithinScope (point 3)', () => {
  const site = { allTenant: false, siteIds: [SITE_A], departmentIds: [] };

  it('couvre tout patient pour la portée établissement', () => {
    expect(isPatientWithinScope({ allTenant: true, siteIds: [], departmentIds: [] }, SITE_B, [])).toBe(true);
  });

  it('couvre le site de la portée, les patients sans site principal, et les sites des services', () => {
    expect(isPatientWithinScope(site, SITE_A, [])).toBe(true);
    expect(isPatientWithinScope(site, null, [])).toBe(true);
    expect(isPatientWithinScope({ allTenant: false, siteIds: [], departmentIds: ['d'] }, SITE_B, [SITE_B])).toBe(true);
  });

  it('refuse un autre site, et tout patient quand la permission n’est pas détenue (portée vide)', () => {
    expect(isPatientWithinScope(site, SITE_B, [])).toBe(false);
    expect(isPatientWithinScope({ allTenant: false, siteIds: [], departmentIds: [] }, null, [])).toBe(false);
  });
});
