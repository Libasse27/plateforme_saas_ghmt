import { describe, expect, it } from 'vitest';
import {
  availableUserActions,
  buildPermissionMatrix,
  toAssignment,
  toDashboard,
  toDepartment,
  toPermissionGroups,
  toPractitionerAdmin,
  toRoleDetail,
  toRoleSummary,
  toSiteAdmin,
  toUserDetail,
  toUserSummary,
  scopeLabel,
  firstValues,
  siteOptionLabel,
} from './admin';

describe('organisation', () => {
  it('lit un site et un service', () => {
    expect(toSiteAdmin({ id: 's1', code: 'DK', name: 'Dakar', city: 'Dakar', countryCode: 'SN', timezone: 'Africa/Dakar', isMain: true })).toEqual({
      id: 's1', code: 'DK', name: 'Dakar', city: 'Dakar', countryCode: 'SN', timezone: 'Africa/Dakar', isMain: true,
    });
    expect(toDepartment({ id: 'd1', siteId: 's1', parentId: null, code: 'MG', name: 'Médecine', kind: 'clinical' })).toEqual({
      id: 'd1', siteId: 's1', parentId: null, code: 'MG', name: 'Médecine', kind: 'clinical',
    });
  });
  it('tolère les formes inattendues', () => {
    expect(toSiteAdmin(null)).toMatchObject({ id: '', name: 'Site', city: '', isMain: false });
    expect(toDepartment(3)).toMatchObject({ id: '', name: 'Service', kind: 'clinical', parentId: null });
  });
});

describe('utilisateurs', () => {
  const raw = { id: 'u1', email: 'a@b.sn', fullName: 'Awa', status: 'active', locale: 'fr', mustChangePassword: true, lastLoginAt: null, createdAt: '2026-10-01T00:00:00.000Z' };
  it('lit un résumé et une fiche avec affectations', () => {
    expect(toUserSummary(raw)).toMatchObject({ id: 'u1', status: 'active', mustChangePassword: true, lastLoginAt: null });
    const detail = toUserDetail({ ...raw, assignments: [{ id: 'a1', roleId: 'r1', roleCode: 'doctor', roleName: 'Médecin', scopeType: 'site', scopeId: 's1', validFrom: '2026-10-01T00:00:00.000Z', validUntil: null }] });
    expect(detail.assignments).toHaveLength(1);
    expect(detail.assignments[0]).toMatchObject({ roleName: 'Médecin', scopeType: 'site', scopeId: 's1' });
  });
  it('statut inconnu replié, affectation vide tolérée', () => {
    expect(toUserSummary({ status: 'x' }).status).toBe('unknown');
    expect(toUserDetail({}).assignments).toEqual([]);
    expect(toAssignment(null)).toMatchObject({ scopeType: 'tenant', scopeId: null, roleName: 'Rôle' });
  });
  it('libellé de portée', () => {
    const sites = [{ id: 's1', name: 'Dakar' }];
    const departments = [{ id: 'd1', name: 'Pédiatrie' }];
    expect(scopeLabel({ scopeType: 'tenant', scopeId: null }, sites, departments)).toBe('Établissement');
    expect(scopeLabel({ scopeType: 'site', scopeId: 's1' }, sites, departments)).toBe('Site : Dakar');
    expect(scopeLabel({ scopeType: 'department', scopeId: 'd1' }, sites, departments)).toBe('Service : Pédiatrie');
    expect(scopeLabel({ scopeType: 'site', scopeId: 'zz' }, sites, departments)).toBe('Site : inconnu');
  });
  it('actions disponibles selon statut et droits', () => {
    const all = { update: true, create: true, revokeSessions: true };
    expect(availableUserActions('invited', all)).toEqual(['resend', 'disable']);
    expect(availableUserActions('active', all)).toEqual(['disable', 'revokeSessions']);
    expect(availableUserActions('locked', all)).toEqual(['unlock', 'disable', 'revokeSessions']);
    expect(availableUserActions('disabled', all)).toEqual(['enable']);
    expect(availableUserActions('unknown', all)).toEqual([]);
    expect(availableUserActions('active', { update: false, create: false, revokeSessions: false })).toEqual([]);
    expect(availableUserActions('invited', { update: false, create: true, revokeSessions: false })).toEqual(['resend']);
  });
});

describe('rôles et matrice', () => {
  it('lit résumé et détail', () => {
    const raw = { id: 'r1', code: 'custom_a', name: 'A', description: null, isSystem: false, mfaRequired: false, permissionCount: 2, permissions: ['patients:patient:read', 7, 'iam:user:read'] };
    expect(toRoleSummary(raw)).toMatchObject({ id: 'r1', isSystem: false, permissionCount: 2, description: '' });
    expect(toRoleDetail(raw).permissions).toEqual(['patients:patient:read', 'iam:user:read']);
    expect(toRoleSummary(undefined)).toMatchObject({ name: 'Rôle', isSystem: true });
  });
  const groups = toPermissionGroups([
    { module: 'patients', name: 'Patients', permissions: [
      { code: 'patients:patient:read', resource: 'patient', action: 'read', isSensitive: false },
      { code: 'patients:patient:delete', resource: 'patient', action: 'delete', isSensitive: true },
      { code: 'patients:consent:read', resource: 'consent', action: 'read', isSensitive: false },
    ] },
    { module: 'iam', name: 'Accès', permissions: [{ code: 'iam:user:read', resource: 'user', action: 'read', isSensitive: false }] },
  ]);
  it('lit le catalogue, ignore les entrées sans code', () => {
    expect(groups).toHaveLength(2);
    expect(toPermissionGroups([{ module: 'x', permissions: [{ resource: 'a' }] }])[0]?.permissions).toEqual([]);
    expect(toPermissionGroups('nope')).toEqual([]);
  });
  it('construit modules x ressources x actions', () => {
    const matrix = buildPermissionMatrix(groups);
    const patients = matrix.find((m) => m.module === 'patients');
    expect(patients?.actions).toEqual(['read', 'delete']);
    expect(patients?.resources.map((r) => r.resource)).toEqual(['patient', 'consent']);
    expect(patients?.resources[0]?.cells.delete).toMatchObject({ code: 'patients:patient:delete', isSensitive: true });
    expect(patients?.resources[1]?.cells.delete).toBeUndefined();
  });
});

describe('praticiens', () => {
  it('lit un praticien', () => {
    expect(toPractitionerAdmin({ id: 'p1', userId: null, fullName: 'Dr X', specialty: null, departmentId: 'd1', primarySiteId: 's1', licenseNumber: null, defaultConsultMinutes: 30, isBookable: true })).toMatchObject({
      id: 'p1', userId: null, specialty: '', defaultConsultMinutes: 30, isBookable: true,
    });
    expect(toPractitionerAdmin({})).toMatchObject({ fullName: 'Praticien', defaultConsultMinutes: 20, isBookable: false });
  });
});

describe('tableau de bord', () => {
  const full = {
    date: '2026-10-05', timezone: 'Africa/Dakar', generatedAt: '2026-10-05T10:00:00.000Z', siteId: null,
    patients: { total: 120, registeredToday: 3 },
    appointments: { total: 9, byStatus: { scheduled: 4, confirmed: 3, cancelled: 2 } },
    revenue: { currency: 'XOF', total: '45000.00', byMethod: { cash: '30000.00', mobile_money: '15000.00' } },
    cashSessions: { openCount: 1, items: [{ id: 'c1', registerCode: 'C1', siteId: 's1', openedAt: '2026-10-05T07:00:00.000Z', openedBy: { id: 'u1', fullName: 'Awa' } }] },
  };
  it('lit toutes les sections et complète les zéros', () => {
    const view = toDashboard(full);
    expect(view.patients).toEqual({ total: 120, registeredToday: 3 });
    expect(view.appointments?.byStatus.scheduled).toBe(4);
    expect(view.appointments?.byStatus.no_show).toBe(0);
    expect(view.revenue?.byMethod).toEqual({ cash: '30000.00', mobile_money: '15000.00', card: '0.00', other: '0.00' });
    expect(view.cashSessions?.items[0]).toMatchObject({ registerCode: 'C1', openedBy: 'Awa' });
  });
  it('sections absentes ou nulles restent nulles', () => {
    const view = toDashboard({ date: '2026-10-05', patients: null });
    expect(view).toMatchObject({ patients: null, appointments: null, revenue: null, cashSessions: null, siteId: null });
    expect(toDashboard(undefined).date).toBe('');
  });
});

describe('utilitaires de page', () => {
  it('firstValues garde la première valeur de chaque paramètre', () => {
    expect(firstValues({ a: 'x', b: ['y', 'z'], c: undefined, d: [] })).toEqual({ a: 'x', b: 'y' });
  });
  it('siteOptionLabel : ville entre parenthèses si présente', () => {
    expect(siteOptionLabel({ name: 'Dakar', city: 'Dakar Plateau' })).toBe('Dakar (Dakar Plateau)');
    expect(siteOptionLabel({ name: 'Thiès', city: '' })).toBe('Thiès');
  });
});
