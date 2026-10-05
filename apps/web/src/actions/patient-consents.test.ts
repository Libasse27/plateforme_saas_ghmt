import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { okEnvelope, problem } from '@/lib/api/test-helpers';

vi.mock('next/navigation', async () => (await import('./test-kit')).navigationMock());
vi.mock('next/cache', async () => (await import('./test-kit')).cacheMock());
vi.mock('next/headers', async () => (await import('./test-kit')).headersMock());

import { revalidatePath } from 'next/cache';
import { recordConsentAction } from './patient-consents';
import { form, stubApi } from './test-kit';

const PATIENT = '3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab';

beforeEach(() => {
  vi.stubEnv('API_URL', 'http://api.test/api/v1');
  vi.stubEnv('SESSION_COOKIE_SECURE', 'false');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.mocked(revalidatePath).mockClear();
});

describe('recordConsentAction', () => {
  it('enregistre un consentement SMS avec la source accueil, sans le patient dans l\'URL du navigateur', async () => {
    const { calls } = stubApi(() => okEnvelope({ patientId: PATIENT, current: [], history: [] }, {}, 201));
    const state = await recordConsentAction({}, form({ patientId: PATIENT, channel: 'sms', granted: 'true' }));
    expect(state).toMatchObject({ ok: true });
    expect(state.message).toContain('accordé');
    const call = calls.find((c) => c.path === `/patients/${PATIENT}/contact-consents`);
    expect(call?.method).toBe('POST');
    expect(call?.body).toEqual({ channel: 'sms', purpose: 'appointment_reminder', granted: true, source: 'front_desk' });
    expect(revalidatePath).toHaveBeenCalledWith(`/patients/${PATIENT}`);
  });
  it('révocation par e-mail', async () => {
    const { calls } = stubApi(() => okEnvelope({}, {}, 201));
    const state = await recordConsentAction({}, form({ patientId: PATIENT, channel: 'email', granted: 'false' }));
    expect(state.message).toContain('révoqué');
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ channel: 'email', granted: false });
  });
  it('refuse canal inconnu, valeur ambiguë ou patient invalide sans appel', async () => {
    const { calls } = stubApi(() => undefined);
    expect((await recordConsentAction({}, form({ patientId: PATIENT, channel: 'fax', granted: 'true' }))).ok).toBe(false);
    expect((await recordConsentAction({}, form({ patientId: PATIENT, channel: 'sms', granted: 'peut-être' }))).ok).toBe(false);
    expect((await recordConsentAction({}, form({ patientId: '../x', channel: 'sms', granted: 'true' }))).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
  it('403 et 404 en français', async () => {
    stubApi(() => problem(403, 'permission_denied'));
    expect((await recordConsentAction({}, form({ patientId: PATIENT, channel: 'sms', granted: 'true' }))).message).toContain('autorisation');
    stubApi(() => problem(404, 'not_found'));
    expect((await recordConsentAction({}, form({ patientId: PATIENT, channel: 'sms', granted: 'true' }))).message).toContain('introuvable');
  });
});
