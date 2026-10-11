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
  resetUserMfaAction,
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
  it('resetUserMfaAction : DELETE /iam/users/{id}/mfa avec le motif, sessions coupées', async () => {
    const { calls } = stubApi(() => new Response(null, { status: 204 }));
    const state = await resetUserMfaAction({}, form({ userId: USER, reason: 'Téléphone perdu, identité vérifiée en face à face.' }));
    expect(state).toMatchObject({ ok: true });
    expect(state.message).toContain('second facteur');
    const call = calls.find((c) => c.path === `/iam/users/${USER}/mfa`);
    expect(call?.method).toBe('DELETE');
    expect(call?.body).toEqual({ reason: 'Téléphone perdu, identité vérifiée en face à face.' });
    expect(revalidatePath).toHaveBeenCalledWith(`/administration/utilisateurs/${USER}`);
  });
  it.each([
    [403, 'admin_hierarchy', 'Seul l\'administrateur principal peut agir sur un autre administrateur.'],
    [403, 'owner_required', 'Seul l\'administrateur principal peut accorder'],
    [409, 'owner_must_transfer', 'transférer'],
    [409, 'mfa_not_enrolled', 'aucun second facteur'],
    [422, 'self_mfa_reset', 'votre propre'],
  ])('codes de hiérarchie : %i %s', async (status, code, fragment) => {
    stubApi(() => problem(status, code));
    const reason = 'Identité vérifiée par rappel sur un numéro connu.';
    for (const action of [resetUserMfaAction, disableUserAction, unlockUserAction, revokeSessionsAction, enableUserAction]) {
      expect((await action({}, form({ userId: USER, reason }))).message).toContain(fragment);
    }
  });
  it('unlockUserAction : POST /iam/users/{id}/unlock avec le motif, qui efface aussi le délai', async () => {
    const { calls } = stubApi(() => new Response(null, { status: 204 }));
    const state = await unlockUserAction({}, form({ userId: USER, reason: 'Collègue joint par téléphone, mot de passe oublié.' }));
    expect(state).toMatchObject({ ok: true });
    expect(state.message).toContain('déverrouillé');
    const call = calls.find((c) => c.path === `/iam/users/${USER}/unlock`);
    expect(call?.method).toBe('POST');
    expect(call?.body).toEqual({ reason: 'Collègue joint par téléphone, mot de passe oublié.' });
  });
  it.each([
    ['réinitialisation du second facteur', resetUserMfaAction],
    ['déverrouillage', unlockUserAction],
  ] as const)('%s : motif obligatoire (10 à 500 caractères), aucun appel sans lui', async (_name, action) => {
    const { calls } = stubApi(() => undefined);
    for (const reason of [undefined, '', 'court', 'a'.repeat(501)]) {
      const state = await action({}, form(reason === undefined ? { userId: USER } : { userId: USER, reason }));
      expect(state.ok).toBe(false);
      expect(state.fieldErrors?.reason).toMatch(/10 à 500/);
    }
    expect(calls).toHaveLength(0);
  });
  it('un motif refusé par l\'API (422 reason_required) est dit clairement', async () => {
    stubApi(() => problem(422, 'reason_required'));
    expect((await resetUserMfaAction({}, form({ userId: USER, reason: 'Motif suffisamment long.' }))).message).toContain('motif');
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
