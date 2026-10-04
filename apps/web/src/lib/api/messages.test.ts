import { describe, expect, it } from 'vitest';
import { describeApiError, fieldErrorsFromApi, GENERIC_ERROR } from './messages';

describe('describeApiError', () => {
  it('traduit les codes connus avant le statut', () => {
    expect(describeApiError({ status: 401, code: 'invalid_credentials' })).toContain('Identifiants invalides');
    expect(describeApiError({ status: 409, code: 'patient_duplicate' })).toContain('patient très proche');
    expect(describeApiError({ status: 409, code: 'slot_unavailable' })).toContain('créneau');
  });
  it('traduit 403, 409, 422, 404 et 429 par statut', () => {
    expect(describeApiError({ status: 403, code: 'permission_denied' })).toContain('pas l\'autorisation');
    expect(describeApiError({ status: 409, code: 'x' })).toContain('conflit');
    expect(describeApiError({ status: 422, code: 'validation_failed' })).toContain('champs');
    expect(describeApiError({ status: 404, code: 'not_found' })).toContain('introuvable');
    expect(describeApiError({ status: 429, code: 'throttled' })).toContain('Trop de tentatives');
  });
  it('gère pannes réseau, 5xx et statuts inconnus', () => {
    expect(describeApiError({ status: 0, code: 'network_error' })).toContain('injoignable');
    expect(describeApiError({ status: 503, code: 'x' })).toContain('problème');
    expect(describeApiError({ status: 418, code: 'x' })).toBe(GENERIC_ERROR);
  });
});

describe('codes métier C1-C9 et B5', () => {
  it('traduit les 409 de transition, concurrence et doublon', () => {
    expect(describeApiError({ status: 409, code: 'invalid_transition' })).toContain('statut');
    expect(describeApiError({ status: 409, code: 'concurrent_update' })).toContain('modifié');
    expect(describeApiError({ status: 409, code: 'duplicate' })).toContain('existe déjà');
  });
  it('traduit les erreurs de précondition, motif et critères', () => {
    expect(describeApiError({ status: 412, code: 'precondition_failed' })).toContain('modifiée');
    expect(describeApiError({ status: 428, code: 'precondition_required' })).toContain('Rechargez');
    expect(describeApiError({ status: 422, code: 'force_reason_required' })).toContain('motif');
    expect(describeApiError({ status: 422, code: 'search_criteria_required' })).toContain('critère');
  });
  it('traduit le changement de mot de passe requis et l\'invitation expirée', () => {
    expect(describeApiError({ status: 403, code: 'password_change_required' })).toContain('mot de passe');
    expect(describeApiError({ status: 410, code: 'invitation_expired' })).toContain('invitation');
  });
});

describe('fieldErrorsFromApi', () => {
  it('conserve le premier message par chemin', () => {
    expect(
      fieldErrorsFromApi([
        { path: 'admin.email', code: 'a', message: 'E-mail invalide.' },
        { path: 'admin.email', code: 'b', message: 'Autre.' },
        { path: 'phone', code: 'c', message: 'Téléphone invalide.' },
      ]),
    ).toEqual({ 'admin.email': 'E-mail invalide.', phone: 'Téléphone invalide.' });
  });
});

describe('patient_duplicate_out_of_scope', () => {
  it('message dédié sans détail', () => {
    expect(describeApiError({ status: 409, code: 'patient_duplicate_out_of_scope' })).toBe(
      'Un dossier correspondant existe dans un autre site. Vérifiez auprès de l\'identitovigilance ou créez le dossier en indiquant un motif.',
    );
  });
});
