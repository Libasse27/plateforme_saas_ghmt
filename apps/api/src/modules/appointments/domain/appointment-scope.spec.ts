import { describe, expect, it } from 'vitest';
import { isWithinScope } from './appointment-scope';

const SITE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SITE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const DEPT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

describe('isWithinScope', () => {
  it('autorise tout site avec une portée établissement', () => {
    expect(isWithinScope({ allTenant: true, siteIds: [], departmentIds: [] }, { siteId: SITE_B })).toBe(true);
  });

  it('autorise uniquement les sites listés', () => {
    const scope = { allTenant: false, siteIds: [SITE_A], departmentIds: [] };
    expect(isWithinScope(scope, { siteId: SITE_A })).toBe(true);
    expect(isWithinScope(scope, { siteId: SITE_B })).toBe(false);
  });

  it('autorise via le service du praticien', () => {
    const scope = { allTenant: false, siteIds: [], departmentIds: [DEPT] };
    expect(isWithinScope(scope, { siteId: SITE_B, departmentId: DEPT })).toBe(true);
    expect(isWithinScope(scope, { siteId: SITE_B, departmentId: null })).toBe(false);
  });

  it('refuse tout sans portée', () => {
    expect(isWithinScope({ allTenant: false, siteIds: [], departmentIds: [] }, { siteId: SITE_A })).toBe(false);
  });
});
