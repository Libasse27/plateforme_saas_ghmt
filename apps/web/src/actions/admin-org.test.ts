import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { okEnvelope, problem } from '@/lib/api/test-helpers';

vi.mock('next/navigation', async () => (await import('./test-kit')).navigationMock());
vi.mock('next/cache', async () => (await import('./test-kit')).cacheMock());
vi.mock('next/headers', async () => (await import('./test-kit')).headersMock());

import { revalidatePath } from 'next/cache';
import { createDepartmentAction, createSiteAction, deleteDepartmentAction, deleteSiteAction, updateDepartmentAction, updateSiteAction } from './admin-org';
import { form, redirectOf, stubApi } from './test-kit';

const ID = '3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
const SITE = '4f2b8c1e-1a2b-4c3d-8e9f-0123456789ab';

beforeEach(() => {
  vi.stubEnv('API_URL', 'http://api.test/api/v1');
  vi.stubEnv('SESSION_COOKIE_SECURE', 'false');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.mocked(revalidatePath).mockClear();
});

describe('createSiteAction', () => {
  it('crée le site et revalide la page organisation', async () => {
    const { calls } = stubApi(() => okEnvelope({ id: ID }, {}, 201));
    const state = await createSiteAction({}, form({ code: 'DK', name: 'Dakar', city: 'Dakar', countryCode: 'sn' }));
    expect(state).toMatchObject({ ok: true, message: 'Site créé.' });
    const call = calls.find((c) => c.path === '/org/sites');
    expect(call?.method).toBe('POST');
    expect(call?.body).toEqual({ code: 'DK', name: 'Dakar', city: 'Dakar', countryCode: 'SN' });
    expect(call?.authorization).toBe('Bearer tenant-access');
    expect(revalidatePath).toHaveBeenCalledWith('/administration/organisation');
  });
  it('validation locale : erreurs de champ sans appel', async () => {
    const { calls } = stubApi(() => undefined);
    const state = await createSiteAction({}, form({ code: '', name: '' }));
    expect(state.ok).toBe(false);
    expect(state.fieldErrors?.name).toBeDefined();
    expect(calls).toHaveLength(0);
  });
  it('422 de l\'API vers les erreurs de champ', async () => {
    stubApi(() => problem(422, 'validation_failed', { errors: [{ path: 'code', code: 'x', message: 'Code invalide' }] }));
    const state = await createSiteAction({}, form({ code: 'DK', name: 'Dakar' }));
    expect(state.fieldErrors).toEqual({ code: 'Code invalide' });
  });
  it('409 code déjà pris et 403 en français', async () => {
    stubApi(() => problem(409, 'site_code_conflict'));
    expect((await createSiteAction({}, form({ code: 'DK', name: 'Dakar' }))).message).toContain('code de site');
    stubApi(() => problem(403, 'permission_denied'));
    expect((await createSiteAction({}, form({ code: 'DK', name: 'Dakar' }))).message).toContain('autorisation');
  });
});

describe('createDepartmentAction', () => {
  it('crée le service sur le site choisi', async () => {
    const { calls } = stubApi(() => okEnvelope({ id: ID }, {}, 201));
    const state = await createDepartmentAction({}, form({ siteId: SITE, code: 'MG', name: 'Médecine', kind: 'clinical' }));
    expect(state.ok).toBe(true);
    expect(calls.find((c) => c.path === '/org/departments')?.body).toEqual({ siteId: SITE, code: 'MG', name: 'Médecine', kind: 'clinical' });
    expect(revalidatePath).toHaveBeenCalledWith('/administration/organisation');
  });
  it('refuse un site manquant', async () => {
    stubApi(() => undefined);
    expect((await createDepartmentAction({}, form({ code: 'MG', name: 'Médecine' }))).fieldErrors?.siteId).toBeDefined();
  });
});

describe('modification et suppression', () => {
  it('updateSiteAction envoie un PATCH et revalide la fiche', async () => {
    const { calls } = stubApi(() => okEnvelope({ id: ID }));
    const state = await updateSiteAction({}, form({ id: ID, name: 'Nouveau', city: 'Thiès' }));
    expect(state).toMatchObject({ ok: true });
    const call = calls.find((c) => c.path === `/org/sites/${ID}`);
    expect(call?.method).toBe('PATCH');
    expect(call?.body).toEqual({ name: 'Nouveau', city: 'Thiès' });
    expect(revalidatePath).toHaveBeenCalledWith('/administration/organisation');
  });
  it('updateDepartmentAction', async () => {
    const { calls } = stubApi(() => okEnvelope({ id: ID }));
    expect((await updateDepartmentAction({}, form({ id: ID, name: 'Pédiatrie', kind: 'clinical' }))).ok).toBe(true);
    expect(calls.find((c) => c.path === `/org/departments/${ID}`)?.method).toBe('PATCH');
  });
  it('identifiant non UUID : demande invalide, aucun appel', async () => {
    const { calls } = stubApi(() => undefined);
    expect((await updateSiteAction({}, form({ id: '../x', name: 'N' }))).ok).toBe(false);
    expect((await deleteSiteAction({}, form({ id: '../x' }))).ok).toBe(false);
    expect((await deleteDepartmentAction({}, form({ id: 'x' }))).ok).toBe(false);
    expect((await updateDepartmentAction({}, form({ id: 'x', name: 'N' }))).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it('suppression : DELETE puis retour à l\'organisation', async () => {
    const { calls } = stubApi(() => new Response(null, { status: 204 }));
    expect(await redirectOf(deleteSiteAction({}, form({ id: ID })))).toBe('/administration/organisation');
    expect(await redirectOf(deleteDepartmentAction({}, form({ id: ID })))).toBe('/administration/organisation');
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([`/org/sites/${ID}`, `/org/departments/${ID}`]);
    expect(revalidatePath).toHaveBeenCalledWith('/administration/organisation');
  });
  it('suppression refusée : message métier', async () => {
    stubApi(() => problem(409, 'site_has_departments'));
    expect((await deleteSiteAction({}, form({ id: ID }))).message).toContain('services');
    stubApi(() => problem(409, 'main_site'));
    expect((await deleteSiteAction({}, form({ id: ID }))).message).toContain('principal');
  });
});
