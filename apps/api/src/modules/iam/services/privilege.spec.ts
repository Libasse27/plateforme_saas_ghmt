import { describe, expect, it } from 'vitest';
import type { EffectiveGrant } from '../../../common/authz/authorization.types';
import { DomainError } from '../../../common/errors/domain-error';
import { assertCanAssign, assertNoEscalation, grantCovers, isDelegableSystemRole, isSensitiveRole, missingPermissions } from './privilege';

const SITE_A = '0198a000-0000-7000-8000-00000000000a';
const SITE_B = '0198a000-0000-7000-8000-00000000000b';
const DEPT_1 = '0198a000-0000-7000-8000-0000000000d1';
const DEPT_2 = '0198a000-0000-7000-8000-0000000000d2';

const grant = (permission: EffectiveGrant['permission'], scopeType: EffectiveGrant['scopeType'], scopeId: string | null = null): EffectiveGrant => ({
  permission,
  scopeType,
  scopeId,
  mfaRequired: false,
});

describe('privilege : couverture de portée', () => {
  it('une permission détenue sur tout l’établissement couvre n’importe quelle portée', () => {
    const grants = [grant('org:site:read', 'tenant')];
    expect(grantCovers(grants, 'org:site:read', { type: 'tenant' })).toBe(true);
    expect(grantCovers(grants, 'org:site:read', { type: 'site', id: SITE_A })).toBe(true);
    expect(grantCovers(grants, 'org:site:read', { type: 'department', id: DEPT_1, siteId: SITE_A })).toBe(true);
  });

  it('une permission limitée à un site ne couvre ni l’établissement ni un autre site', () => {
    const grants = [grant('org:site:read', 'site', SITE_A)];
    expect(grantCovers(grants, 'org:site:read', { type: 'site', id: SITE_A })).toBe(true);
    expect(grantCovers(grants, 'org:site:read', { type: 'site', id: SITE_B })).toBe(false);
    expect(grantCovers(grants, 'org:site:read', { type: 'tenant' })).toBe(false);
  });

  it('une permission de site couvre les services de ce site seulement', () => {
    const grants = [grant('org:site:read', 'site', SITE_A)];
    expect(grantCovers(grants, 'org:site:read', { type: 'department', id: DEPT_1, siteId: SITE_A })).toBe(true);
    expect(grantCovers(grants, 'org:site:read', { type: 'department', id: DEPT_2, siteId: SITE_B })).toBe(false);
  });

  it('une permission de service ne couvre que ce service (pas le site)', () => {
    const grants = [grant('org:site:read', 'department', DEPT_1)];
    expect(grantCovers(grants, 'org:site:read', { type: 'department', id: DEPT_1, siteId: SITE_A })).toBe(true);
    expect(grantCovers(grants, 'org:site:read', { type: 'department', id: DEPT_2, siteId: SITE_A })).toBe(false);
    expect(grantCovers(grants, 'org:site:read', { type: 'site', id: SITE_A })).toBe(false);
  });

  it('ne tient pas compte des autres permissions', () => {
    expect(grantCovers([grant('org:site:update', 'tenant')], 'org:site:read', { type: 'tenant' })).toBe(false);
  });
});

describe('privilege : anti-escalade', () => {
  const grants = [grant('iam:user:read', 'tenant'), grant('iam:role:read', 'tenant')];

  it('liste les permissions que l’acteur ne détient pas', () => {
    const missing = missingPermissions(grants, ['iam:user:read', 'iam:user:delete', 'billing:invoice:read'], { type: 'tenant' });
    expect(missing).toEqual(['iam:user:delete', 'billing:invoice:read']);
  });

  it('accepte une composition entièrement détenue par l’acteur', () => {
    expect(() => assertNoEscalation(grants, ['iam:user:read'], { type: 'tenant' })).not.toThrow();
  });

  it('accepte un rôle sans permission', () => {
    expect(() => assertNoEscalation([], [], { type: 'tenant' })).not.toThrow();
  });

  it('refuse avec le code privilege_escalation (403) sans lister les permissions manquantes', () => {
    let error: unknown;
    try {
      assertNoEscalation(grants, ['iam:user:read', 'iam:user:delete'], { type: 'tenant' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code: 'privilege_escalation', status: 403 });
  });

  it('refuse d’affecter sur une portée plus large que celle de l’acteur', () => {
    const siteGrants = [grant('iam:user:read', 'site', SITE_A)];
    expect(() => assertNoEscalation(siteGrants, ['iam:user:read'], { type: 'tenant' })).toThrow(DomainError);
    expect(() => assertNoEscalation(siteGrants, ['iam:user:read'], { type: 'site', id: SITE_A })).not.toThrow();
  });
});

describe('privilege : délégation des rôles système (décision du 2026-10-04)', () => {
  const ADMIN = '0198a000-0000-7000-8000-0000000000a1';
  const OTHER = '0198a000-0000-7000-8000-0000000000a2';
  const doctorRole = { isSystem: true, permissions: ['consultations:consultation:create', 'patients:patient:read'] };
  const adminRole = { isSystem: true, permissions: ['iam:user:create', 'iam:assignment:create'] };
  const directorRole = { isSystem: true, permissions: ['iam:user:read', 'reports:dashboard:read'] };
  const customClinical = { isSystem: false, permissions: ['consultations:consultation:create'] };
  const adminGrants = [grant('iam:assignment:create', 'tenant'), grant('iam:user:create', 'tenant')];
  const toOther = { actorUserId: ADMIN, targetUserId: OTHER, assignmentPermission: 'iam:assignment:create' } as const;

  it('autorise l’admin à déléguer un rôle système clinique à un autre utilisateur', () => {
    expect(() => assertCanAssign(adminGrants, doctorRole, { type: 'tenant' }, toOther)).not.toThrow();
  });

  it('refuse l’auto-affectation d’un rôle système dont on ne détient pas les droits', () => {
    const self = { ...toOther, targetUserId: ADMIN };
    expect(() => assertCanAssign(adminGrants, doctorRole, { type: 'tenant' }, self)).toThrow(DomainError);
  });

  it('applique l’anti-escalade stricte aux rôles personnalisés', () => {
    expect(() => assertCanAssign(adminGrants, customClinical, { type: 'tenant' }, toOther)).toThrow(DomainError);
  });

  it('exige la permission d’affectation sur la portée visée pour déléguer', () => {
    const siteGrants = [grant('iam:assignment:create', 'site', SITE_A)];
    expect(() => assertCanAssign(siteGrants, doctorRole, { type: 'site', id: SITE_A }, toOther)).not.toThrow();
    expect(() => assertCanAssign(siteGrants, doctorRole, { type: 'site', id: SITE_B }, toOther)).toThrow(DomainError);
  });

  it('ne rend jamais délégable un rôle portant des droits d’administration en écriture', () => {
    expect(isDelegableSystemRole(adminRole)).toBe(false);
    expect(isDelegableSystemRole(directorRole)).toBe(true);
    expect(isDelegableSystemRole(customClinical)).toBe(false);
    const delegate = [grant('iam:assignment:create', 'tenant')];
    expect(() => assertCanAssign(delegate, adminRole, { type: 'tenant' }, toOther)).toThrow(DomainError);
  });
});

describe('isSensitiveRole (H2)', () => {
  it('signale un rôle donnant accès à un module clinique ou financier', () => {
    expect(isSensitiveRole(['consultations:consultation:read'])).toBe(true);
    expect(isSensitiveRole(['org:site:read', 'pharmacy:dispensation:create'])).toBe(true);
    expect(isSensitiveRole(['accounting:journal:read'])).toBe(true);
    expect(isSensitiveRole(['cashier:session:create'])).toBe(true);
  });

  it('ne signale pas un rôle administratif ou d’accueil', () => {
    expect(isSensitiveRole([])).toBe(false);
    expect(isSensitiveRole(['iam:user:create', 'org:site:read', 'patients:patient:read', 'appointments:appointment:create', 'billing:invoice:read'])).toBe(false);
  });
});
