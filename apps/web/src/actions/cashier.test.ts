import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { okEnvelope, problem } from '@/lib/api/test-helpers';

vi.mock('next/navigation', async () => (await import('./test-kit')).navigationMock());
vi.mock('next/cache', async () => (await import('./test-kit')).cacheMock());
vi.mock('next/headers', async () => (await import('./test-kit')).headersMock());

import { closeSessionAction, createRegisterAction, forceCloseSessionAction, openSessionAction, validateSessionAction } from './cashier';
import { form, stubApi } from './test-kit';

const SITE = '4a2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
const REGISTER = 'aa2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
const SESSION = '8e2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
const NBSP = ' ';

beforeEach(() => {
  vi.stubEnv('API_URL', 'http://api.test/api/v1');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('createRegisterAction', () => {
  it('crée une caisse', async () => {
    const { calls } = stubApi(() => okEnvelope({ id: REGISTER }, {}, 201));
    expect((await createRegisterAction({}, form({ siteId: SITE, code: 'C1', name: 'Caisse principale' }))).message).toBe('Caisse créée.');
    expect(calls.at(-1)).toMatchObject({ path: '/cashier/registers', body: { siteId: SITE, code: 'C1', name: 'Caisse principale' } });
  });
  it('champs invalides et code déjà pris', async () => {
    stubApi(() => problem(409, 'cash_register_code_taken'));
    expect((await createRegisterAction({}, form({ siteId: 'x', code: '', name: '' }))).fieldErrors).toBeDefined();
    expect((await createRegisterAction({}, form({ siteId: SITE, code: 'C1', name: 'Caisse' }))).message).toContain('code de caisse');
  });
});

describe('openSessionAction', () => {
  it('ouvre une session avec le fond de caisse', async () => {
    const { calls } = stubApi(() => okEnvelope({ id: SESSION }, {}, 201));
    const state = await openSessionAction({}, form({ cashRegisterId: REGISTER, openingFloat: '20 000' }));
    expect(state.ok).toBe(true);
    expect(calls.at(-1)?.body).toEqual({ cashRegisterId: REGISTER, openingFloat: '20000.00' });
  });
  it('fond invalide, caisse invalide, session déjà ouverte', async () => {
    stubApi(() => problem(409, 'cash_session_already_open'));
    expect((await openSessionAction({}, form({ cashRegisterId: REGISTER, openingFloat: 'abc' }))).fieldErrors?.openingFloat).toBeDefined();
    expect((await openSessionAction({}, form({ cashRegisterId: 'x', openingFloat: '0' }))).fieldErrors?.cashRegisterId).toBeDefined();
    expect((await openSessionAction({}, form({ cashRegisterId: REGISTER, openingFloat: '0' }))).message).toContain('déjà ouverte');
  });
});

describe('closeSessionAction', () => {
  const CLOSED = { id: SESSION, status: 'closed', currency: 'XOF', openingFloat: '20000.00', expectedTotal: '60000.00', closingCounted: '59000.00', variance: '-1000.00' };

  it('affiche attendu, compté et écart renvoyés par l\'API', async () => {
    const { calls } = stubApi(() => okEnvelope(CLOSED));
    const state = await closeSessionAction({}, form({ sessionId: SESSION, countedAmount: '59 000', note: ' billet déchiré ' }));
    expect(state.ok).toBe(true);
    expect(state.message).toContain(`Attendu : 60${NBSP}000${NBSP}FCFA`);
    expect(state.message).toContain(`compté : 59${NBSP}000${NBSP}FCFA`);
    expect(state.message).toContain(`écart : -1${NBSP}000${NBSP}FCFA`);
    expect(calls.at(-1)?.body).toEqual({ countedAmount: '59000.00', note: 'billet déchiré' });
  });
  it('montant invalide, identifiant invalide, non propriétaire', async () => {
    stubApi(() => problem(403, 'cash_session_not_owner'));
    expect((await closeSessionAction({}, form({ sessionId: SESSION, countedAmount: '-3' }))).fieldErrors?.countedAmount).toBeDefined();
    expect((await closeSessionAction({}, form({ sessionId: 'x', countedAmount: '3' }))).ok).toBe(false);
    expect((await closeSessionAction({}, form({ sessionId: SESSION, countedAmount: '3' }))).message).toContain('ouvert la session');
  });
});

describe('validateSessionAction', () => {
  it('valide une session clôturée', async () => {
    const { calls } = stubApi(() => okEnvelope({ id: SESSION }));
    expect((await validateSessionAction({}, form({ sessionId: SESSION }))).message).toBe('Session validée.');
    expect(calls.at(-1)?.path).toBe(`/cashier/sessions/${SESSION}/validate`);
  });
  it('explique separation_of_duties', async () => {
    stubApi(() => problem(403, 'separation_of_duties'));
    const state = await validateSessionAction({}, form({ sessionId: SESSION }));
    expect(state.ok).toBe(false);
    expect(state.message).toContain('séparation des tâches');
    expect((await validateSessionAction({}, form({ sessionId: 'x' }))).ok).toBe(false);
  });
});

describe('R8 : note obligatoire si écart et clôture forcée', () => {
  const CLOSED = { id: SESSION, status: 'closed', currency: 'XOF', expectedTotal: '60000.00', closingCounted: '59000.00', variance: '-1000.00' };

  it('exige une note quand l\'écart n\'est pas nul (aucun appel)', async () => {
    const { calls } = stubApi(() => okEnvelope(CLOSED));
    const state = await closeSessionAction({}, form({ sessionId: SESSION, countedAmount: '59000', expectedTotal: '60000.00', currency: 'XOF' }));
    expect(state.fieldErrors?.note).toContain('obligatoire');
    expect(calls.some((c) => c.path.endsWith('/close'))).toBe(false);
  });
  it('accepte sans note quand l\'écart est nul, ou avec une note', async () => {
    const { calls } = stubApi(() => okEnvelope(CLOSED));
    expect((await closeSessionAction({}, form({ sessionId: SESSION, countedAmount: '60 000', expectedTotal: '60000.00' }))).ok).toBe(true);
    expect((await closeSessionAction({}, form({ sessionId: SESSION, countedAmount: '59000', expectedTotal: '60000.00', note: 'billet déchiré' }))).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });
  it('renvoie l\'erreur de champ de l\'API si elle exige la note', async () => {
    stubApi(() => problem(422, 'validation_failed', { errors: [{ path: 'note', message: 'note obligatoire' }] }));
    const state = await closeSessionAction({}, form({ sessionId: SESSION, countedAmount: '59000' }));
    expect(state.ok).toBe(false);
  });
  it('clôture forcée : montant et motif obligatoires', async () => {
    const { calls } = stubApi(() => okEnvelope(CLOSED));
    const missing = await forceCloseSessionAction({}, form({ sessionId: SESSION, countedAmount: '', reason: 'a' }));
    expect(missing.fieldErrors).toMatchObject({ countedAmount: expect.any(String), reason: expect.any(String) });
    expect((await forceCloseSessionAction({}, form({ sessionId: 'x', countedAmount: '1', reason: 'oubli' }))).ok).toBe(false);
    expect(calls).toHaveLength(0);
    const state = await forceCloseSessionAction({}, form({ sessionId: SESSION, countedAmount: '59 000', reason: ' caissier absent ' }));
    expect(state.ok).toBe(true);
    expect(state.message).toContain(`écart : -1${NBSP}000${NBSP}FCFA`);
    expect(calls.at(-1)).toMatchObject({ path: `/cashier/sessions/${SESSION}/force-close`, body: { countedAmount: '59000.00', reason: 'caissier absent' } });
  });
  it('clôture forcée : motif trop long, erreur API (interdit à l\'ouvreur)', async () => {
    stubApi(() => problem(403, 'cash_session_not_owner'));
    expect((await forceCloseSessionAction({}, form({ sessionId: SESSION, countedAmount: '1', reason: 'x'.repeat(501) }))).fieldErrors?.reason).toContain('500');
    expect((await forceCloseSessionAction({}, form({ sessionId: SESSION, countedAmount: '1', reason: 'oubli' }))).ok).toBe(false);
  });
});
