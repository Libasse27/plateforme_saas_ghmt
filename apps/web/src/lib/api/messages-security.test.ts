import { describe, expect, it } from 'vitest';
import { describeApiError, retryAfterSecondsOf } from './messages';

const text = (status: number, code: string, extras?: Record<string, unknown>) => describeApiError({ status, code, extras });

describe('messages du durcissement sécurité (docs/11)', () => {
  it('login_delayed cite le nombre de secondes du détail', () => {
    expect(text(429, 'login_delayed', { details: { retryAfterSeconds: 30 } })).toBe('Trop de tentatives pour ce compte. Réessayez dans 30 secondes.');
    expect(text(429, 'login_delayed', { details: { retryAfterSeconds: 1 } })).toBe('Trop de tentatives pour ce compte. Réessayez dans 1 seconde.');
  });

  it('login_delayed sans détail exploitable : formulation sans durée, jamais « NaN »', () => {
    for (const extras of [undefined, {}, { details: {} }, { details: { retryAfterSeconds: 'x' } }, { details: { retryAfterSeconds: -4 } }]) {
      const message = text(429, 'login_delayed', extras);
      expect(message).toContain('Trop de tentatives pour ce compte');
      expect(message).not.toMatch(/NaN|undefined|-4/);
    }
  });

  it('retryAfterSecondsOf accepte un entier positif borné et arrondit à l\'entier supérieur', () => {
    expect(retryAfterSecondsOf({ details: { retryAfterSeconds: 900 } })).toBe(900);
    expect(retryAfterSecondsOf({ details: { retryAfterSeconds: 29.2 } })).toBe(30);
    expect(retryAfterSecondsOf({ details: { retryAfterSeconds: 0 } })).toBeNull();
    expect(retryAfterSecondsOf({ details: { retryAfterSeconds: 10 ** 9 } })).toBeNull();
    expect(retryAfterSecondsOf(undefined)).toBeNull();
    expect(retryAfterSecondsOf({ details: [] })).toBeNull();
  });

  it.each([
    ['email_verification_required', 403, 'Confirmez l\'adresse e-mail'],
    ['reset_token_invalid', 410, 'invalide ou a expiré'],
    ['verification_token_invalid', 410, 'invalide, déjà utilisé ou expiré'],
    ['mfa_code_required', 422, 'code de vérification'],
    ['mfa_email_code_required', 403, 'code reçu par e-mail'],
    ['invalid_email_code', 422, 'code reçu par e-mail'],
    ['email_code_not_required', 422, 'réseau de confiance'],
    ['mfa_already_enrolled', 409, 'déjà activé'],
    ['admin_hierarchy', 403, 'Seul l\'administrateur principal peut agir sur un autre administrateur.'],
    ['owner_required', 403, 'administrateur principal'],
    ['owner_must_transfer', 409, 'transférer'],
    ['owner_target_invalid', 422, 'second facteur'],
    ['self_mfa_reset', 422, 'votre propre'],
    ['mfa_not_enrolled', 409, 'aucun second facteur'],
    ['invalid_cidr', 422, 'plage réseau'],
    ['cidr_too_broad', 422, 'trop large'],
    ['cidr_reserved', 422, 'réservée'],
    ['mfa_step_up_required', 401, 'code à 6 chiffres'],
    ['mfa_code_invalid', 401, 'invalide ou expiré'],
    ['template_locked', 422, 'ne peut pas être modifié'],
    ['reason_required', 422, 'motif'],
    ['trusted_network_limit', 422, '50'],
    ['trusted_network_exists', 409, 'déjà déclarée'],
    ['slug_reserved', 422, 'réservé'],
    ['slug_taken', 409, 'déjà utilisé'],
  ])('%s (%i) a un message français explicite', (code, status, fragment) => {
    expect(text(status, code)).toContain(fragment);
  });

  it('les messages de hiérarchie ne divulguent aucun identifiant', () => {
    for (const code of ['admin_hierarchy', 'owner_required', 'owner_must_transfer']) {
      expect(text(403, code, { details: { userId: 'abc-123' } })).not.toContain('abc-123');
    }
  });

  it('cidr_too_broad cite les nouveaux préfixes minimaux (/24 et /48)', () => {
    const message = text(422, 'cidr_too_broad');
    expect(message).toContain('/24');
    expect(message).toContain('/48');
  });

  describe('mfa_enrollment_required (contexte établissement, docs/11 §14.4)', () => {
    it('hors réseau de confiance : message propre à l\'établissement', () => {
      expect(text(403, 'mfa_enrollment_required', { offNetwork: true })).toBe(
        'Vous n\'êtes plus sur le réseau de l\'établissement : activez le second facteur pour continuer.',
      );
    });
    it('sur le réseau (rôle à second facteur obligatoire) : activation demandée, sans mention du réseau', () => {
      const message = text(403, 'mfa_enrollment_required', { offNetwork: false });
      expect(message).toContain('Activez le second facteur');
      expect(message).not.toContain('plateforme');
      expect(message).not.toContain('réseau de l\'établissement');
    });
    it('sans indicateur : le message de la console plateforme est conservé', () => {
      expect(text(403, 'mfa_enrollment_required')).toContain('console plateforme');
    });
  });
});
