import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { okEnvelope, problem } from '@/lib/api/test-helpers';

vi.mock('next/navigation', async () => (await import('./test-kit')).navigationMock());
vi.mock('next/cache', async () => (await import('./test-kit')).cacheMock());
vi.mock('next/headers', async () => (await import('./test-kit')).headersMock());

import { revalidatePath } from 'next/cache';
import { addTrustedNetworkAction, removeTrustedNetworkAction, transferOwnershipAction, updateSecurityPolicyAction } from './admin-security';
import { form, stubApi } from './test-kit';

const NETWORK = '3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
const SITE = '5f2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
const USER = '6f2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
const PAGE = '/administration/securite';

beforeEach(() => {
  vi.stubEnv('API_URL', 'http://api.test/api/v1');
  vi.stubEnv('SESSION_COOKIE_SECURE', 'false');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.mocked(revalidatePath).mockClear();
});

describe('updateSecurityPolicyAction', () => {
  it('PATCH /iam/security/policy avec le mode et le code du second facteur, puis revalide la page', async () => {
    const { calls } = stubApi(() => okEnvelope({}));
    const state = await updateSecurityPolicyAction({}, form({ clinicalMfa: 'always', totpCode: '123456' }));
    expect(state).toMatchObject({ ok: true, message: 'Politique d\'authentification enregistrée.' });
    const call = calls.find((c) => c.path === '/iam/security/policy');
    expect(call?.method).toBe('PATCH');
    expect(call?.body).toEqual({ clinicalMfa: 'always', totpCode: '123456' });
    expect(revalidatePath).toHaveBeenCalledWith(PAGE);
  });

  it('refuse un mode inconnu (aucun mode « désactivé ») sans appel', async () => {
    const { calls } = stubApi(() => undefined);
    const state = await updateSecurityPolicyAction({}, form({ clinicalMfa: 'disabled', totpCode: '123456' }));
    expect(state.ok).toBe(false);
    expect(state.fieldErrors?.clinicalMfa).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('403 : message d\'autorisation', async () => {
    stubApi(() => problem(403, 'permission_denied'));
    expect((await updateSecurityPolicyAction({}, form({ clinicalMfa: 'always', totpCode: '123456' }))).message).toContain('autorisation');
  });

  it('code du second facteur absent : refus local sur le champ, aucun appel', async () => {
    const { calls } = stubApi(() => undefined);
    const state = await updateSecurityPolicyAction({}, form({ clinicalMfa: 'always' }));
    expect(state.fieldErrors?.totpCode).toMatch(/6 chiffres/);
    expect(calls).toHaveLength(0);
  });

  it('403 owner_required : réservé à l\'administrateur principal', async () => {
    stubApi(() => problem(403, 'owner_required'));
    expect((await updateSecurityPolicyAction({}, form({ clinicalMfa: 'always', totpCode: '123456' }))).message).toContain('administrateur principal');
  });

  it('401 mfa_step_up_required / mfa_code_invalid : message sur le champ du code, SANS déconnexion ni écho du code', async () => {
    for (const code of ['mfa_step_up_required', 'mfa_code_invalid']) {
      const { calls } = stubApi(() => problem(401, code));
      const state = await updateSecurityPolicyAction({}, form({ clinicalMfa: 'always', totpCode: '123456' }));
      expect(state.ok).toBe(false);
      expect(state.fieldErrors?.totpCode).toBe(state.message);
      expect(JSON.stringify(state)).not.toContain('123456');
      expect(calls.filter((c) => c.path === '/iam/security/policy')).toHaveLength(1);
    }
  });
});

describe('addTrustedNetworkAction', () => {
  it('POST avec la plage normalisée, le libellé et le site', async () => {
    const { calls } = stubApi(() => okEnvelope({ id: NETWORK }, {}, 201));
    const state = await addTrustedNetworkAction({}, form({ cidr: '203.0.113.9/24', label: 'Siège', siteId: SITE, totpCode: '123456' }));
    expect(state).toMatchObject({ ok: true, message: 'Plage réseau ajoutée.' });
    expect(calls.find((c) => c.path === '/iam/security/trusted-networks')?.body).toEqual({ cidr: '203.0.113.0/24', label: 'Siège', siteId: SITE, totpCode: '123456' });
    expect(revalidatePath).toHaveBeenCalledWith(PAGE);
  });

  it('validation locale : plage trop large ou invalide, libellé court, aucun appel', async () => {
    const { calls } = stubApi(() => undefined);
    expect((await addTrustedNetworkAction({}, form({ cidr: '10.0.0.0/8', label: 'Siège', totpCode: '123456' }))).fieldErrors?.cidr).toContain('trop large');
    expect((await addTrustedNetworkAction({}, form({ cidr: 'abc', label: 'Siège', totpCode: '123456' }))).fieldErrors?.cidr).toBeTruthy();
    expect((await addTrustedNetworkAction({}, form({ cidr: '203.0.113.0/24', label: 'x', totpCode: '123456' }))).fieldErrors?.label).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('erreurs de l\'API : doublon, limite, plage trop large côté serveur, site introuvable', async () => {
    const input = form({ cidr: '203.0.113.0/24', label: 'Siège', totpCode: '123456' });
    stubApi(() => problem(409, 'trusted_network_exists'));
    expect((await addTrustedNetworkAction({}, input)).message).toContain('déjà déclarée');
    stubApi(() => problem(422, 'trusted_network_limit'));
    expect((await addTrustedNetworkAction({}, input)).message).toContain('50');
    stubApi(() => problem(422, 'cidr_too_broad'));
    expect((await addTrustedNetworkAction({}, input)).message).toContain('trop large');
    stubApi(() => problem(422, 'cidr_reserved'));
    expect((await addTrustedNetworkAction({}, input)).message).toContain('réservée');
    stubApi(() => problem(422, 'scope_not_found'));
    expect((await addTrustedNetworkAction({}, input)).message).toContain('introuvable');
  });

  it('« Ajouter ce réseau » : l\'adresse est relue côté serveur dans la politique, jamais crue du navigateur', async () => {
    const { calls } = stubApi((call) => (call.path === '/iam/security/policy' ? okEnvelope({ requestIp: '203.0.113.50' }) : okEnvelope({ id: NETWORK }, {}, 201)));
    const state = await addTrustedNetworkAction({}, form({ useCurrentIp: '1', cidr: '8.8.8.8/32', label: 'Mon adresse', totpCode: '123456' }));
    expect(state.ok).toBe(true);
    expect(calls.find((c) => c.path === '/iam/security/trusted-networks')?.body).toEqual({ cidr: '203.0.113.50/32', label: 'Mon adresse', totpCode: '123456' });
  });

  it('« Ajouter ce réseau » sans adresse connue : message clair, aucune écriture', async () => {
    const { calls } = stubApi((call) => (call.path === '/iam/security/policy' ? okEnvelope({ requestIp: null }) : undefined));
    const state = await addTrustedNetworkAction({}, form({ useCurrentIp: '1', label: 'Mon adresse', totpCode: '123456' }));
    expect(state.ok).toBe(false);
    expect(state.message).toContain('adresse actuelle');
    expect(calls.some((c) => c.path === '/iam/security/trusted-networks')).toBe(false);
  });
});

describe('removeTrustedNetworkAction', () => {
  it('DELETE de la plage, le code du second facteur dans le corps JSON', async () => {
    const { calls } = stubApi(() => new Response(null, { status: 204 }));
    expect(await removeTrustedNetworkAction({}, form({ networkId: NETWORK, totpCode: '123456' }))).toMatchObject({ ok: true, message: 'Plage réseau supprimée.' });
    const call = calls.find((c) => c.path === `/iam/security/trusted-networks/${NETWORK}`);
    expect(call?.method).toBe('DELETE');
    expect(call?.body).toEqual({ totpCode: '123456' });
    expect(revalidatePath).toHaveBeenCalledWith(PAGE);
  });

  it('identifiant invalide : aucun appel (anti-injection de chemin)', async () => {
    const { calls } = stubApi(() => undefined);
    expect((await removeTrustedNetworkAction({}, form({ networkId: '../../iam/users', totpCode: '123456' }))).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('404 : élément introuvable', async () => {
    stubApi(() => problem(404, 'not_found'));
    expect((await removeTrustedNetworkAction({}, form({ networkId: NETWORK, totpCode: '123456' }))).message).toContain('introuvable');
  });

  it('code absent : refus sur le champ, aucun appel ; code faux (401) : message sur le champ', async () => {
    const { calls } = stubApi(() => undefined);
    expect((await removeTrustedNetworkAction({}, form({ networkId: NETWORK }))).fieldErrors?.totpCode).toBeTruthy();
    expect(calls).toHaveLength(0);
    stubApi(() => problem(401, 'mfa_code_invalid'));
    expect((await removeTrustedNetworkAction({}, form({ networkId: NETWORK, totpCode: '000000' }))).fieldErrors?.totpCode).toContain('invalide');
  });
});

describe('transferOwnershipAction', () => {
  it('POST /iam/security/owner puis revalide la sécurité et les utilisateurs', async () => {
    const { calls } = stubApi(() => okEnvelope({}));
    expect(await transferOwnershipAction({}, form({ userId: USER, totpCode: '123456' }))).toMatchObject({ ok: true, message: 'Le titre d\'administrateur principal a été transféré.' });
    const call = calls.find((c) => c.path === '/iam/security/owner');
    expect(call?.method).toBe('POST');
    expect(call?.body).toEqual({ userId: USER, totpCode: '123456' });
    expect(revalidatePath).toHaveBeenCalledWith(PAGE);
    expect(revalidatePath).toHaveBeenCalledWith('/administration/utilisateurs');
  });

  it('codes de hiérarchie : owner_required (403) et owner_target_invalid (422)', async () => {
    stubApi(() => problem(403, 'owner_required'));
    expect((await transferOwnershipAction({}, form({ userId: USER, totpCode: '123456' }))).message).toContain('administrateur principal');
    stubApi(() => problem(422, 'owner_target_invalid'));
    expect((await transferOwnershipAction({}, form({ userId: USER, totpCode: '123456' }))).message).toContain('second facteur');
  });

  it('401 mfa_step_up_required : champ du code, sans déconnexion', async () => {
    stubApi(() => problem(401, 'mfa_step_up_required'));
    const state = await transferOwnershipAction({}, form({ userId: USER, totpCode: '123456' }));
    expect(state.fieldErrors?.totpCode).toContain('6 chiffres');
  });

  it('utilisateur non choisi ou invalide : aucun appel', async () => {
    const { calls } = stubApi(() => undefined);
    expect((await transferOwnershipAction({}, form({ userId: '', totpCode: '123456' }))).fieldErrors?.userId).toBeTruthy();
    expect((await transferOwnershipAction({}, form({ userId: 'x', totpCode: '123456' }))).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
