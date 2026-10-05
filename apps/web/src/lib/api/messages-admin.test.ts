import { describe, expect, it } from 'vitest';
import { describeApiError } from './messages';

const text = (status: number, code: string, extras?: Record<string, unknown>) => describeApiError({ status, code, extras });

describe('messages de la console d\'administration', () => {
  it('invitation : compte créé mais e-mail non envoyé', () => {
    expect(text(502, 'invitation_email_failed')).toContain('compte a été créé');
    expect(text(502, 'invitation_email_failed')).toContain('renvoyez l\'invitation');
  });
  it.each([
    ['last_admin', 'dernier administrateur'],
    ['email_already_used', 'e-mail'],
    ['role_code_conflict', 'code de rôle'],
    ['system_role_immutable', 'rôles système'],
    ['role_in_use', 'affecté'],
    ['privilege_escalation', 'ne détenez pas'],
    ['site_code_conflict', 'code de site'],
    ['department_code_conflict', 'code de service'],
    ['main_site', 'site principal'],
    ['site_has_departments', 'services'],
    ['department_has_children', 'sous-services'],
    ['assignment_exists', 'déjà cette affectation'],
    ['out_of_scope', 'périmètre'],
    ['invalid_validity', 'validité'],
    ['user_disabled', 'désactivé'],
    ['export_too_large', '10 000'],
    ['range_too_large', 'période'],
    ['preference_locked', 'verrouillée'],
    ['empty_update', 'modifier'],
  ])('traduit %s', (code, fragment) => {
    expect(text(409, code)).toContain(fragment);
  });
  it('export trop volumineux cite le nombre de lignes', () => {
    expect(text(422, 'export_too_large', { details: { count: 25000, max: 10000 } })).toContain('25');
  });
});
