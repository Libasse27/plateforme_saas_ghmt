import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { okEnvelope, problem } from '@/lib/api/test-helpers';

vi.mock('next/navigation', async () => (await import('./test-kit')).navigationMock());
vi.mock('next/cache', async () => (await import('./test-kit')).cacheMock());
vi.mock('next/headers', async () => (await import('./test-kit')).headersMock());

import { createAppointmentAction } from './appointments';
import { form, stubApi } from './test-kit';

const ID = '3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
const FIELDS = { patientId: ID, practitionerId: ID, siteId: ID, date: '2026-11-03', time: '09:30', duration: '30' };

beforeEach(() => {
  vi.stubEnv('API_URL', 'http://api.test/api/v1');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('createAppointmentAction : source du rendez-vous', () => {
  it('n\'envoie jamais « web » ou « mobile_app » : le personnel envoie front_desk', async () => {
    const { calls } = stubApi(() => okEnvelope({ id: ID }, {}, 201));
    for (const source of ['web', 'mobile_app', 'phone', undefined]) {
      const fields: Record<string, string> = source ? { ...FIELDS, source } : FIELDS;
      expect((await createAppointmentAction({}, form(fields))).ok).toBe(true);
    }
    const bodies = calls.filter((c) => c.path === '/appointments').map((c) => c.body as { source: string });
    expect(bodies).toHaveLength(4);
    expect(bodies.every((body) => body.source === 'front_desk')).toBe(true);
  });

  it('une source refusée par l\'API (422) donne un message de champ lisible', async () => {
    stubApi(() => problem(422, 'validation_failed', { errors: [{ path: 'source', message: 'source non autorisée' }] }));
    const state = await createAppointmentAction({}, form(FIELDS));
    expect(state.ok).toBe(false);
    expect(state.fieldErrors?.source).toBe('source non autorisée');
  });
});
