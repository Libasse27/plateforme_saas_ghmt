import { describe, expect, it } from 'vitest';
import { ALL_PERMISSIONS, expandPatterns, isPermissionKey, moduleOf, patternMatches } from './catalog';
import { ROLE_TEMPLATES, findRoleTemplate, permissionsForTemplate } from './role-templates';

describe('catalogue de permissions', () => {
  it('produit des codes uniques au format module:ressource:action', () => {
    const codes = ALL_PERMISSIONS.map((p) => p.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toMatch(/^[a-z_]+:[a-z_]+:[a-z]+$/);
  });

  it('marque comme sensibles la lecture clinique, les exports et les validations', () => {
    const byCode = new Map(ALL_PERMISSIONS.map((p) => [p.code, p]));
    expect(byCode.get('patients:patient:read')?.isSensitive).toBe(true);
    expect(byCode.get('billing:invoice:export')?.isSensitive).toBe(true);
    expect(byCode.get('org:site:read')?.isSensitive).toBe(false);
  });

  it('reconnaît uniquement les permissions du catalogue', () => {
    expect(isPermissionKey('patients:patient:read')).toBe(true);
    expect(isPermissionKey('patients:patient:fly')).toBe(false);
    expect(isPermissionKey('patients:*:read')).toBe(false);
  });

  it('extrait le module d’une permission', () => {
    expect(moduleOf('appointments:appointment:create')).toBe('appointments');
  });

  it('applique les jokers segment par segment', () => {
    expect(patternMatches('patients:*:read', 'patients:patient:read')).toBe(true);
    expect(patternMatches('patients:*:read', 'patients:patient:update')).toBe(false);
    expect(patternMatches('*:*:*', 'iam:user:read')).toBe(true);
    expect(patternMatches('patients:patient', 'patients:patient:read')).toBe(false);
  });

  it('développe les motifs sans doublon', () => {
    const perms = expandPatterns(['iam:user:*', 'iam:user:read']);
    expect(perms).toEqual(['iam:user:create', 'iam:user:delete', 'iam:user:export', 'iam:user:read', 'iam:user:update']);
  });
});

describe('modèles de rôles', () => {
  it('chaque motif de chaque modèle couvre au moins une permission réelle', () => {
    for (const template of ROLE_TEMPLATES) {
      for (const pattern of template.patterns) {
        expect(expandPatterns([pattern]), `${template.code} → ${pattern}`).not.toHaveLength(0);
      }
    }
  });

  it('n’accorde aucun accès clinique à l’administrateur (séparation des tâches)', () => {
    const admin = permissionsForTemplate(findRoleTemplate('tenant_admin')!);
    expect(admin).toContain('iam:user:create');
    expect(admin.some((p) => p.startsWith('consultations:'))).toBe(false);
    expect(admin).not.toContain('patients:patient:update');
  });

  it('ne permet pas au technicien de laboratoire de valider un résultat', () => {
    const tech = permissionsForTemplate(findRoleTemplate('lab_technician')!);
    expect(tech).toContain('laboratory:result:create');
    expect(tech).not.toContain('laboratory:result:validate');
  });

  it('donne au réceptionniste la gestion des rendez-vous, hors suppression', () => {
    const rec = permissionsForTemplate(findRoleTemplate('receptionist')!);
    expect(rec).toEqual(expect.arrayContaining(['appointments:appointment:create', 'appointments:appointment:update', 'appointments:agenda:read']));
  });
});

describe('administrateur : configuration des agendas', () => {
  it('peut gérer l’annuaire des praticiens sans lire les rendez-vous nominatifs', () => {
    const admin = permissionsForTemplate(findRoleTemplate('tenant_admin')!);
    expect(admin).toEqual(expect.arrayContaining(['appointments:agenda:read', 'appointments:agenda:update']));
    expect(admin).not.toContain('appointments:appointment:read');
  });
});

describe('modèles de rôles corrigés (A11)', () => {
  it('retire la suppression de rendez-vous au réceptionniste et à l’agent administratif', () => {
    for (const code of ['receptionist', 'admin_agent']) {
      const perms = permissionsForTemplate(findRoleTemplate(code)!);
      expect(perms, code).not.toContain('appointments:appointment:delete');
      expect(perms, code).toContain('appointments:appointment:update');
    }
  });

  it('ne donne aucune lecture de rendez-vous au directeur', () => {
    const director = permissionsForTemplate(findRoleTemplate('director')!);
    expect(director.filter((p) => p.startsWith('appointments:') && p.endsWith(':read'))).toEqual([]);
  });
});
