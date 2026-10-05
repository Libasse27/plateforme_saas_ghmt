import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { okEnvelope, problem } from '@/lib/api/test-helpers';

vi.mock('next/navigation', async () => (await import('./test-kit')).navigationMock());
vi.mock('next/cache', async () => (await import('./test-kit')).cacheMock());
vi.mock('next/headers', async () => (await import('./test-kit')).headersMock());

import { revalidatePath } from 'next/cache';
import { markAllReadAction, markReadAction, updatePreferencesAction } from './notifications';
import { form, stubApi } from './test-kit';

const ID = '3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab';

beforeEach(() => {
  vi.stubEnv('API_URL', 'http://api.test/api/v1');
  vi.stubEnv('SESSION_COOKIE_SECURE', 'false');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.mocked(revalidatePath).mockClear();
});

describe('markReadAction', () => {
  it('POST /read puis revalide la boîte et le layout (cloche)', async () => {
    const { calls } = stubApi(() => okEnvelope({ id: ID }));
    expect((await markReadAction({}, form({ id: ID }))).ok).toBe(true);
    expect(calls.find((c) => c.path === `/notifications/inbox/${ID}/read`)?.method).toBe('POST');
    expect(revalidatePath).toHaveBeenCalledWith('/notifications');
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });
  it('identifiant invalide : aucun appel ; 404 en français', async () => {
    const { calls } = stubApi(() => undefined);
    expect((await markReadAction({}, form({ id: '../x' }))).ok).toBe(false);
    expect(calls).toHaveLength(0);
    stubApi(() => problem(404, 'not_found'));
    expect((await markReadAction({}, form({ id: ID }))).message).toContain('introuvable');
  });
});

describe('markAllReadAction', () => {
  it('annonce le nombre de messages marqués', async () => {
    const { calls } = stubApi(() => okEnvelope({ updated: 3 }));
    const state = await markAllReadAction();
    expect(state).toMatchObject({ ok: true });
    expect(state.message).toContain('3');
    expect(calls.find((c) => c.path === '/notifications/inbox/read-all')?.method).toBe('POST');
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });
  it('aucun message à marquer', async () => {
    stubApi(() => okEnvelope({ updated: 0 }));
    expect((await markAllReadAction()).message).toContain('Aucune');
  });
  it('erreur serveur', async () => {
    stubApi(() => problem(503, 'x'));
    expect((await markAllReadAction()).ok).toBe(false);
  });
});

describe('updatePreferencesAction', () => {
  it('envoie une entrée par préférence modifiable, case décochée = désactivée', async () => {
    const { calls } = stubApi(() => okEnvelope({ items: [] }));
    const state = await updatePreferencesAction({}, form({ known: 'administrative:email' }));
    expect(state).toMatchObject({ ok: true });
    const call = calls.find((c) => c.path === '/notifications/preferences');
    expect(call?.method).toBe('PUT');
    expect(call?.body).toEqual({ items: [{ category: 'administrative', channel: 'email', enabled: false }] });
    expect(revalidatePath).toHaveBeenCalledWith('/notifications/preferences');
  });
  it('case cochée = activée', async () => {
    const { calls } = stubApi(() => okEnvelope({ items: [] }));
    await updatePreferencesAction({}, form({ known: 'administrative:email', 'pref.administrative:email': 'on' }));
    expect(calls.find((c) => c.path === '/notifications/preferences')?.body).toEqual({ items: [{ category: 'administrative', channel: 'email', enabled: true }] });
  });
  it('ignore les clés inconnues, rien à envoyer : demande invalide', async () => {
    const { calls } = stubApi(() => undefined);
    expect((await updatePreferencesAction({}, form({ known: 'marketing:sms,../x' }))).ok).toBe(false);
    expect((await updatePreferencesAction({}, form({}))).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it('422 preference_locked', async () => {
    stubApi(() => problem(422, 'preference_locked'));
    expect((await updatePreferencesAction({}, form({ known: 'administrative:email' }))).message).toContain('verrouillée');
  });
});
