import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', async () => (await import('./test-kit')).navigationMock());

import { ApiError } from '@/lib/api/errors';
import { failureState } from './helpers';
import { Redirect } from './test-kit';

function apiError(code: string, extras: Record<string, unknown> = {}): ApiError {
  return new ApiError({ status: 409, code, title: code, detail: code, errors: [], extras, requestId: 'r' } as never);
}

describe('failureState', () => {
  it('doublon classique : candidats + forçable', () => {
    const state = failureState(apiError('patient_duplicate', { details: { candidates: [{ id: 'a', fullName: 'Awa NDIAYE' }] } }));
    expect(state.extra).toMatchObject({ forceable: true, candidates: [{ id: 'a', fullName: 'Awa NDIAYE' }] });
  });
  it('doublon hors périmètre : forçable sans aucun candidat ni détail', () => {
    const state = failureState(apiError('patient_duplicate_out_of_scope', { details: { candidates: [{ id: 'fuite' }] } }));
    expect(state.extra).toEqual({ candidates: [], forceable: true });
    expect(state.message).toContain('autre site');
  });
  it('autre erreur : pas de forçage', () => {
    expect(failureState(apiError('duplicate')).extra).toBeUndefined();
  });
  it('relance une erreur inattendue', () => {
    expect(() => failureState(new Error('bug'))).toThrow('bug');
  });
});

describe('failureState avec détails', () => {
  it('cite le reste dû dans la devise fournie', () => {
    const state = failureState(apiError('amount_exceeds_balance', { details: { balance: '500.00' } }), { amount: '900' }, { currency: 'XOF' });
    expect(state.message).toContain('reste dû');
    expect(state.message).toContain('500');
    expect(state.values).toEqual({ amount: '900' });
  });
});

describe('failureState : mfa_enrollment_required (docs/11 §14.4)', () => {
  const enrolment = (offNetwork: boolean) => new ApiError({ status: 403, code: 'mfa_enrollment_required', extras: { offNetwork } });

  it('redirige vers /securite/mfa quand aucune saisie n\'est à conserver', () => {
    expect(() => failureState(enrolment(true))).toThrow(Redirect);
    try {
      failureState(enrolment(true));
    } catch (error) {
      expect((error as Redirect).url).toBe('/securite/mfa');
    }
  });

  it('redirige aussi quand les valeurs fournies sont vides', () => {
    expect(() => failureState(enrolment(false), {})).toThrow(Redirect);
  });

  it('conserve la saisie : renvoie l\'état avec le message de l\'établissement et un lien d\'activation', () => {
    const state = failureState(enrolment(true), { fullName: 'Awa Diop' });
    expect(state.ok).toBe(false);
    expect(state.message).toContain('Vous n\'êtes plus sur le réseau de l\'établissement');
    expect(state.values).toEqual({ fullName: 'Awa Diop' });
    expect(state.extra).toEqual({ mfaEnrolmentPath: '/securite/mfa' });
  });

  it('sans indicateur offNetwork (console plateforme) : aucun détournement vers l\'établissement', () => {
    const state = failureState(new ApiError({ status: 403, code: 'mfa_enrollment_required' }));
    expect(state.message).toContain('console plateforme');
  });
});
