import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { okEnvelope, problem } from '@/lib/api/test-helpers';

vi.mock('next/navigation', async () => (await import('./test-kit')).navigationMock());
vi.mock('next/cache', async () => (await import('./test-kit')).cacheMock());
vi.mock('next/headers', async () => (await import('./test-kit')).headersMock());

import { revalidatePath } from 'next/cache';
import { createRoleAction, deleteRoleAction, updateRoleAction } from './admin-roles';
import { redirectOf, stubApi } from './test-kit';

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

function roleForm(fields: Record<string, string>, permissions: string[] = []): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  for (const permission of permissions) data.append('permissions', permission);
  return data;
}

describe('createRoleAction', () => {
  it('envoie toutes les cases cochées (valeurs multiples) et redirige vers le rôle', async () => {
    const { calls } = stubApi((c) => (c.path === '/iam/roles' ? okEnvelope({ id: ID }, {}, 201) : undefined));
    const url = await redirectOf(createRoleAction({}, roleForm({ code: 'infirmier_chef', name: 'Infirmier chef' }, ['patients:patient:read', 'patients:patient:update'])));
    expect(url).toBe(`/administration/roles/${ID}`);
    expect(calls.find((c) => c.path === '/iam/roles')?.body).toEqual({ code: 'infirmier_chef', name: 'Infirmier chef', permissions: ['patients:patient:read', 'patients:patient:update'] });
    expect(revalidatePath).toHaveBeenCalledWith('/administration/roles');
  });
  it('sans identifiant renvoyé : succès sur place', async () => {
    stubApi(() => okEnvelope({}, {}, 201));
    expect(await createRoleAction({}, roleForm({ code: 'role_test', name: 'Rôle test' }))).toMatchObject({ ok: true });
  });
  it('code invalide : erreur locale sans appel', async () => {
    const { calls } = stubApi(() => undefined);
    expect((await createRoleAction({}, roleForm({ code: 'X', name: 'Rôle' }))).fieldErrors?.code).toBeDefined();
    expect(calls).toHaveLength(0);
  });
  it('409 code déjà utilisé, 403 élévation de privilège', async () => {
    stubApi(() => problem(409, 'role_code_conflict'));
    expect((await createRoleAction({}, roleForm({ code: 'role_test', name: 'Rôle test' }))).message).toContain('code de rôle');
    stubApi(() => problem(403, 'privilege_escalation'));
    expect((await createRoleAction({}, roleForm({ code: 'role_test', name: 'Rôle test' }, ['iam:user:read']))).message).toContain('ne détenez pas');
  });
});

describe('updateRoleAction', () => {
  it('PATCH avec la matrice complète et revalidation', async () => {
    const { calls } = stubApi(() => okEnvelope({ id: ID }));
    const state = await updateRoleAction({}, roleForm({ id: ID, name: 'Nouveau nom', description: 'Desc' }, ['patients:patient:read']));
    expect(state).toMatchObject({ ok: true });
    const call = calls.find((c) => c.path === `/iam/roles/${ID}`);
    expect(call?.method).toBe('PATCH');
    expect(call?.body).toEqual({ name: 'Nouveau nom', description: 'Desc', permissions: ['patients:patient:read'] });
    expect(revalidatePath).toHaveBeenCalledWith(`/administration/roles/${ID}`);
  });
  it('rôle système : refus de l\'API en français ; identifiant invalide', async () => {
    stubApi(() => problem(409, 'system_role_immutable'));
    expect((await updateRoleAction({}, roleForm({ id: ID, name: 'Nom' }))).message).toContain('rôles système');
    const { calls } = stubApi(() => undefined);
    expect((await updateRoleAction({}, roleForm({ id: 'x', name: 'Nom' }))).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('deleteRoleAction', () => {
  it('DELETE puis retour à la liste', async () => {
    const { calls } = stubApi(() => new Response(null, { status: 204 }));
    expect(await redirectOf(deleteRoleAction({}, roleForm({ id: ID })))).toBe('/administration/roles');
    expect(calls.find((c) => c.method === 'DELETE')?.path).toBe(`/iam/roles/${ID}`);
  });
  it('rôle encore affecté : message ; identifiant invalide', async () => {
    stubApi(() => problem(409, 'role_in_use'));
    expect((await deleteRoleAction({}, roleForm({ id: ID }))).message).toContain('affecté');
    expect((await deleteRoleAction({}, roleForm({ id: 'x' }))).ok).toBe(false);
  });
});
