import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { okEnvelope, problem } from '@/lib/api/test-helpers';

vi.mock('next/navigation', async () => (await import('./test-kit')).navigationMock());
vi.mock('next/cache', async () => (await import('./test-kit')).cacheMock());
vi.mock('next/headers', async () => (await import('./test-kit')).headersMock());

import { revalidatePath } from 'next/cache';
import { createPractitionerAction, updatePractitionerAction } from './admin-practitioners';
import { form, redirectOf, stubApi } from './test-kit';

const ID = '3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
const DEPT = '4f2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
const SITE = '5f2b8c1e-1a2b-4c3d-8e9f-0123456789ab';

beforeEach(() => {
  vi.stubEnv('API_URL', 'http://api.test/api/v1');
  vi.stubEnv('SESSION_COOKIE_SECURE', 'false');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.mocked(revalidatePath).mockClear();
});

describe('createPractitionerAction', () => {
  it('crée le praticien et redirige vers sa fiche', async () => {
    const { calls } = stubApi((c) => (c.path === '/practitioners' ? okEnvelope({ id: ID }, {}, 201) : undefined));
    const url = await redirectOf(createPractitionerAction({}, form({ fullName: 'Dr Awa Ndiaye', specialty: 'Pédiatrie', departmentId: DEPT, primarySiteId: SITE, defaultConsultMinutes: '30', isBookable: 'on' })));
    expect(url).toBe(`/administration/praticiens/${ID}`);
    expect(calls.find((c) => c.path === '/practitioners')?.body).toEqual({ fullName: 'Dr Awa Ndiaye', specialty: 'Pédiatrie', departmentId: DEPT, primarySiteId: SITE, defaultConsultMinutes: 30, isBookable: true });
    expect(revalidatePath).toHaveBeenCalledWith('/administration/praticiens');
  });
  it('sans identifiant renvoyé : succès sur place', async () => {
    stubApi(() => okEnvelope({}, {}, 201));
    expect(await createPractitionerAction({}, form({ fullName: 'Dr Awa Ndiaye' }))).toMatchObject({ ok: true });
  });
  it('validation locale et 422 de l\'API', async () => {
    const { calls } = stubApi(() => undefined);
    expect((await createPractitionerAction({}, form({ fullName: 'D' }))).fieldErrors?.fullName).toBeDefined();
    expect(calls).toHaveLength(0);
    stubApi(() => problem(422, 'validation_failed', { errors: [{ path: 'userId', code: 'not_found', message: 'Utilisateur introuvable' }] }));
    expect((await createPractitionerAction({}, form({ fullName: 'Dr Awa Ndiaye' }))).fieldErrors).toEqual({ userId: 'Utilisateur introuvable' });
  });
});

describe('updatePractitionerAction', () => {
  it('PATCH et revalidation de la fiche', async () => {
    const { calls } = stubApi(() => okEnvelope({ id: ID }));
    const state = await updatePractitionerAction({}, form({ id: ID, fullName: 'Dr Awa Ndiaye', defaultConsultMinutes: '25' }));
    expect(state).toMatchObject({ ok: true });
    const call = calls.find((c) => c.path === `/practitioners/${ID}`);
    expect(call?.method).toBe('PATCH');
    expect(call?.body).toEqual({ fullName: 'Dr Awa Ndiaye', defaultConsultMinutes: 25, isBookable: false });
    expect(revalidatePath).toHaveBeenCalledWith(`/administration/praticiens/${ID}`);
  });
  it('identifiant invalide, 403', async () => {
    const { calls } = stubApi(() => undefined);
    expect((await updatePractitionerAction({}, form({ id: 'x', fullName: 'Dr Awa' }))).ok).toBe(false);
    expect(calls).toHaveLength(0);
    stubApi(() => problem(403, 'permission_denied'));
    expect((await updatePractitionerAction({}, form({ id: ID, fullName: 'Dr Awa' }))).message).toContain('autorisation');
  });
});
