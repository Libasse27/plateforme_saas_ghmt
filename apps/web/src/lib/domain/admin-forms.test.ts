import { describe, expect, it } from 'vitest';
import { assignmentForm, departmentForm, inviteForm, practitionerForm, roleForm, siteForm, endOfDayIso } from './admin-forms';

const SITE = '0190c1a0-1111-7000-8000-000000000001';
const DEPT = '0190c1a0-2222-7000-8000-000000000002';
const ROLE = '0190c1a0-3333-7000-8000-000000000003';
const USER = '0190c1a0-4444-7000-8000-000000000004';

describe('siteForm', () => {
  it('crée un site, omet les champs vides, met le pays en majuscules', () => {
    expect(siteForm({ code: 'DK', name: 'Dakar', city: '', countryCode: 'sn', timezone: 'Africa/Dakar' }, 'create')).toEqual({
      ok: true, data: { code: 'DK', name: 'Dakar', countryCode: 'SN', timezone: 'Africa/Dakar' },
    });
  });
  it('signale les champs invalides en français', () => {
    const result = siteForm({ code: '', name: 'D' }, 'create');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.errors)).toEqual(expect.arrayContaining(['code', 'name']));
  });
  it('modification partielle', () => {
    expect(siteForm({ name: 'Nouveau nom' }, 'update')).toEqual({ ok: true, data: { name: 'Nouveau nom' } });
  });
});

describe('departmentForm', () => {
  it('création avec site et nature', () => {
    expect(departmentForm({ siteId: SITE, code: 'MG', name: 'Médecine', kind: 'clinical' }, 'create')).toEqual({
      ok: true, data: { siteId: SITE, code: 'MG', name: 'Médecine', kind: 'clinical' },
    });
  });
  it('refuse un site non uuid ; la modification ne transmet pas le site', () => {
    expect(departmentForm({ siteId: 'x', code: 'MG', name: 'Médecine' }, 'create').ok).toBe(false);
    expect(departmentForm({ siteId: SITE, name: 'Médecine B', kind: 'support' }, 'update')).toEqual({ ok: true, data: { name: 'Médecine B', kind: 'support' } });
  });
});

describe('inviteForm', () => {
  it('invitation sans affectation initiale', () => {
    expect(inviteForm({ fullName: 'Awa Diop', email: 'AWA@clinique.sn', locale: 'fr', roleId: '' })).toEqual({
      ok: true, data: { fullName: 'Awa Diop', email: 'awa@clinique.sn', locale: 'fr', roleAssignments: [] },
    });
  });
  it('invitation avec rôle à portée site', () => {
    const result = inviteForm({ fullName: 'Awa Diop', email: 'awa@clinique.sn', locale: 'en', roleId: ROLE, scopeType: 'site', siteId: SITE });
    expect(result).toEqual({
      ok: true,
      data: { fullName: 'Awa Diop', email: 'awa@clinique.sn', locale: 'en', roleAssignments: [{ roleId: ROLE, scopeType: 'site', scopeId: SITE }] },
    });
  });
  it('erreurs de champ : e-mail invalide, portée sans site', () => {
    const bad = inviteForm({ fullName: 'A', email: 'x', locale: 'fr', roleId: ROLE, scopeType: 'site' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.email).toBeDefined();
  });
});

describe('assignmentForm', () => {
  it('portée établissement : aucun scopeId, fin de validité en fin de journée', () => {
    expect(assignmentForm({ roleId: ROLE, scopeType: 'tenant', siteId: SITE, validUntil: '2026-12-31' })).toEqual({
      ok: true, data: { roleId: ROLE, scopeType: 'tenant', validUntil: '2026-12-31T23:59:59.000Z' },
    });
  });
  it('portée service', () => {
    expect(assignmentForm({ roleId: ROLE, scopeType: 'department', departmentId: DEPT })).toEqual({
      ok: true, data: { roleId: ROLE, scopeType: 'department', scopeId: DEPT },
    });
  });
  it('refuse portée sans cible et date invalide', () => {
    const noScope = assignmentForm({ roleId: ROLE, scopeType: 'site' });
    expect(noScope.ok).toBe(false);
    const badDate = assignmentForm({ roleId: ROLE, scopeType: 'tenant', validUntil: '31/12/2026' });
    expect(badDate.ok).toBe(false);
    if (!badDate.ok) expect(badDate.errors.validUntil).toBeDefined();
  });
  it('endOfDayIso', () => {
    expect(endOfDayIso('2026-02-28')).toBe('2026-02-28T23:59:59.000Z');
    expect(endOfDayIso('2026-02-30')).toBeNull();
    expect(endOfDayIso('')).toBeNull();
  });
});

describe('roleForm', () => {
  it('création avec permissions dédoublonnées', () => {
    expect(roleForm({ code: 'infirmier_chef', name: 'Infirmier chef', description: 'Coordination' }, ['patients:patient:read', 'patients:patient:read'], 'create')).toEqual({
      ok: true, data: { code: 'infirmier_chef', name: 'Infirmier chef', description: 'Coordination', permissions: ['patients:patient:read'] },
    });
  });
  it('permission inconnue et code invalide refusés', () => {
    const result = roleForm({ code: 'X', name: 'N' }, ['foo:bar:baz'], 'create');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.code).toBeDefined();
  });
  it('modification : nom, description et permissions (liste vide autorisée)', () => {
    expect(roleForm({ name: 'Nouveau' }, [], 'update')).toEqual({ ok: true, data: { name: 'Nouveau', permissions: [] } });
  });
});

describe('practitionerForm', () => {
  it('création complète', () => {
    expect(practitionerForm({ fullName: 'Dr Awa', specialty: 'Pédiatrie', departmentId: DEPT, primarySiteId: SITE, licenseNumber: 'L1', defaultConsultMinutes: '30', isBookable: 'on', userId: USER }, 'create')).toEqual({
      ok: true,
      data: { fullName: 'Dr Awa', specialty: 'Pédiatrie', departmentId: DEPT, primarySiteId: SITE, licenseNumber: 'L1', defaultConsultMinutes: 30, isBookable: true, userId: USER },
    });
  });
  it('durée invalide et case décochée', () => {
    const bad = practitionerForm({ fullName: 'Dr Awa', defaultConsultMinutes: '2' }, 'create');
    expect(bad.ok).toBe(false);
    const ok = practitionerForm({ fullName: 'Dr Awa', defaultConsultMinutes: '20' }, 'update');
    expect(ok).toEqual({ ok: true, data: { fullName: 'Dr Awa', defaultConsultMinutes: 20, isBookable: false } });
  });
  it('durée non numérique', () => {
    const bad = practitionerForm({ fullName: 'Dr Awa', defaultConsultMinutes: 'abc' }, 'create');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.defaultConsultMinutes).toBeDefined();
  });
});
