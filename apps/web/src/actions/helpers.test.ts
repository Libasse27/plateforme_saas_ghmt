import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/errors';
import { failureState } from './helpers';

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
