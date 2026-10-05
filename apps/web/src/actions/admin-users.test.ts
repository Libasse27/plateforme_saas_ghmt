import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { okEnvelope, problem } from '@/lib/api/test-helpers';

vi.mock('next/navigation', async () => (await import('./test-kit')).navigationMock());
vi.mock('next/cache', async () => (await import('./test-kit')).cacheMock());
vi.mock('next/headers', async () => (await import('./test-kit')).headersMock());

import { revalidatePath } from 'next/cache';
import {
  addAssignmentAction,
  disableUserAction,
  enableUserAction,
  inviteUserAction,
  resendInvitationAction,
  revokeAssignmentAction,
  revokeSessionsAction,
  unlockUserAction,
  updateUserAction,
} from './admin-users';
import { form, redirectOf, stubApi } from './test-kit';

const USER = '3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
const ROLE = '4f2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
const SITE = '5f2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
const ASSIGNMENT = '6f2b8c1e-1a2b-4c3d-8e9f-0123456789ab';

beforeEach(() => {
  vi.stubEnv('API_URL', 'http://api.test/api/v1');
  vi.stubEnv('SESSION_COOKIE_SECURE', 'false');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.mocked(revalidatePath).mockClear();
});

describe('inviteUserAction', () => {
  it('crée le compte avec le rôle initial et redirige vers sa fiche', async () => {
    const { calls } = stubApi((c) => (c.path === '/iam/users' ? okEnvelope({ id: USER }, {}, 201) : undefined));
    const url = await redirectOf(inviteUserAction({}, form({ fullName: 'Awa Diop', email: 'awa@clinique.sn', locale: 'fr', roleId: ROLE, scopeType: 'site', siteId: SITE })));
    expect(url).toBe(`/administration/utilisateurs/${USER}`);
    expect(calls.find((c) => c.path === '/iam/users')?.body).toEqual({
      fullName: 'Awa Diop', email: 'awa@clinique.sn', locale: 'fr', roleAssignments: [{ roleId: ROLE, scopeType: 'site', scopeId: SITE }],
    });
    expect(revalidatePath).toHaveBeenCalledWith('/administration/utilisateurs');
  });
  it('sans identifiant renvoyé : succès sur place', async () => {
    stubApi(() => okEnvelope({}, {}, 201));
    expect(await inviteUserAction({}, form({ fullName: 'Awa Diop', email: 'awa@clinique.sn', locale: 'fr' }))).toMatchObject({ ok: true });
  });
  it('502 invitation_email_failed : compte créé, renvoyez l\'invitation', async () => {
    stubApi(() => problem(502, 'invitation_email_failed'));
    const state = await inviteUserAction({}, form({ fullName: 'Awa Diop', email: 'awa@clinique.sn', locale: 'fr' }));
    expect(state.ok).toBe(false);
    expect(state.message).toContain('compte a été créé');
    expect(revalidatePath).toHaveBeenCalledWith('/administration/utilisateurs');
  });
  it('409 e-mail déjà utilisé, 422 de champ, validation locale', async () => {
    stubApi(() => problem(409, 'email_already_used'));
    expect((await inviteUserAction({}, form({ fullName: 'Awa Diop', email: 'awa@clinique.sn', locale: 'fr' }))).message).toContain('e-mail');
    stubApi(() => problem(422, 'validation_failed', { errors: [{ path: 'email', code: 'x', message: 'E-mail refusé' }] }));
    expect((await inviteUserAction({}, form({ fullName: 'Awa Diop', email: 'awa@clinique.sn', locale: 'fr' }))).fieldErrors).toEqual({ email: 'E-mail refusé' });
    const { calls } = stubApi(() => undefined);
    expect((await inviteUserAction({}, form({ fullName: 'A', email: 'nope' }))).fieldErrors?.email).toBeDefined();
    expect(calls).toHaveLength(0);
  });
});

describe('updateUserAction', () => {
  it('PATCH du nom et de la langue', async () => {
    const { calls } = stubApi(() => okEnvelope({ id: USER }));
    expect((await updateUserAction({}, form({ userId: USER, fullName: 'Awa D.', locale: 'en' }))).ok).toBe(true);
    const call = calls.find((c) => c.path === `/iam/users/${USER}`);
    expect(call?.method).toBe('PATCH');
    expect(call?.body).toEqual({ fullName: 'Awa D.', locale: 'en' });
    expect(revalidatePath).toHaveBeenCalledWith(`/administration/utilisateurs/${USER}`);
  });
  it('refuse un nom trop court, un identifiant invalide ou une langue inconnue', async () => {
    const { calls } = stubApi(() => undefined);
    expect((await updateUserAction({}, form({ userId: USER, fullName: 'A', locale: 'fr' }))).fieldErrors?.fullName).toBeDefined();
    expect((await updateUserAction({}, form({ userId: 'x', fullName: 'Awa D.', locale: 'fr' }))).ok).toBe(false);
    expect((await updateUserAction({}, form({ userId: USER, fullName: 'Awa D.', locale: 'de' }))).fieldErrors?.locale).toBeDefined();
    expect(calls).toHaveLength(0);
  });
});

describe('commandes sur un utilisateur', () => {
  it.each([
    [resendInvitationAction, 'invitation', 'POST', 'Invitation renvoyée'],
    [disableUserAction, 'disable', 'POST', 'désactivé'],
    [enableUserAction, 'enable', 'POST', 'réactivé'],
    [unlockUserAction, 'unlock', 'POST', 'déverrouillé'],
    [revokeSessionsAction, 'sessions', 'DELETE', 'sessions'],
  ] as const)('%s appelle /iam/users/{id}/%s', async (action, suffix, method, fragment) => {
    const { calls } = stubApi(() => new Response(null, { status: 204 }));
    const state = await action({}, form({ userId: USER }));
    expect(state.ok).toBe(true);
    expect(state.message).toContain(fragment);
    const call = calls.find((c) => c.path === `/iam/users/${USER}/${suffix}`);
    expect(call?.method).toBe(method);
    expect(revalidatePath).toHaveBeenCalledWith(`/administration/utilisateurs/${USER}`);
  });
  it('409 dernier administrateur et 403', async () => {
    stubApi(() => problem(409, 'last_admin'));
    expect((await disableUserAction({}, form({ userId: USER }))).message).toContain('dernier administrateur');
    stubApi(() => problem(403, 'permission_denied'));
    expect((await revokeSessionsAction({}, form({ userId: USER }))).message).toContain('autorisation');
  });
  it('identifiant invalide : aucun appel', async () => {
    const { calls } = stubApi(() => undefined);
    expect((await unlockUserAction({}, form({ userId: '../x' }))).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('affectations', () => {
  it('ajoute un rôle à portée site avec fin de validité', async () => {
    const { calls } = stubApi(() => okEnvelope({ id: ASSIGNMENT }, {}, 201));
    const state = await addAssignmentAction({}, form({ userId: USER, roleId: ROLE, scopeType: 'site', siteId: SITE, validUntil: '2026-12-31' }));
    expect(state.ok).toBe(true);
    expect(calls.find((c) => c.path === `/iam/users/${USER}/assignments`)?.body).toEqual({ roleId: ROLE, scopeType: 'site', scopeId: SITE, validUntil: '2026-12-31T23:59:59.000Z' });
  });
  it('refuse une portée sans cible, signale un doublon ou une élévation', async () => {
    const { calls } = stubApi(() => undefined);
    expect((await addAssignmentAction({}, form({ userId: USER, roleId: ROLE, scopeType: 'site' }))).fieldErrors?.siteId).toBeDefined();
    expect(calls).toHaveLength(0);
    stubApi(() => problem(409, 'assignment_exists'));
    expect((await addAssignmentAction({}, form({ userId: USER, roleId: ROLE, scopeType: 'tenant' }))).message).toContain('déjà cette affectation');
    stubApi(() => problem(403, 'privilege_escalation'));
    expect((await addAssignmentAction({}, form({ userId: USER, roleId: ROLE, scopeType: 'tenant' }))).message).toContain('ne détenez pas');
  });
  it('retire une affectation', async () => {
    const { calls } = stubApi(() => new Response(null, { status: 204 }));
    expect((await revokeAssignmentAction({}, form({ userId: USER, assignmentId: ASSIGNMENT }))).ok).toBe(true);
    expect(calls.find((c) => c.method === 'DELETE')?.path).toBe(`/iam/users/${USER}/assignments/${ASSIGNMENT}`);
  });
  it('identifiants invalides', async () => {
    const { calls } = stubApi(() => undefined);
    expect((await revokeAssignmentAction({}, form({ userId: USER, assignmentId: 'x' }))).ok).toBe(false);
    expect((await addAssignmentAction({}, form({ userId: 'x', roleId: ROLE }))).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
