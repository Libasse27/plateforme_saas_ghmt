import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/errors';

const PATIENT = '0190c1a0-1111-7000-8000-000000000001';
const state = vi.hoisted(() => ({ permissions: [] as string[], routes: new Map<string, unknown>(), calls: [] as string[] }));

vi.mock('next/navigation', async () => (await import('@/actions/test-kit')).navigationMock());
vi.mock('next/cache', async () => (await import('@/actions/test-kit')).cacheMock());
vi.mock('next/headers', async () => (await import('@/actions/test-kit')).headersMock());
vi.mock('@/server/me', () => ({
  requireMe: async () => ({ user: { id: 'u' }, tenant: { timezone: 'Africa/Dakar' }, permissions: state.permissions, modules: ['patients'] }),
}));
vi.mock('@/server/api', () => ({
  actionApi: vi.fn(),
  pageApi: async (path: string) => {
    state.calls.push(path);
    const route = state.routes.get(path);
    if (route instanceof Error) throw route;
    if (route === undefined) throw new ApiError({ status: 404, code: 'not_found' });
    return { data: route, meta: {}, status: 200 };
  },
}));

import PatientPage from './[id]/page';

const CONSENTS = { patientId: PATIENT, current: [{ channel: 'sms', purpose: 'appointment_reminder', granted: true, source: 'front_desk', recordedAt: '2026-10-01T08:00:00.000Z' }], history: [] };

beforeEach(() => {
  state.permissions = ['patients:patient:read'];
  state.routes.clear();
  state.calls.length = 0;
  state.routes.set(`/patients/${PATIENT}`, { id: PATIENT, firstName: 'Awa', lastName: 'Diop' });
});

const render_ = async () => render(await PatientPage({ params: Promise.resolve({ id: PATIENT }) }));

describe('bloc « Rappels de rendez-vous » de la fiche patient', () => {
  it('absent et sans appel sans la permission patients:consent:read', async () => {
    await render_();
    expect(screen.queryByRole('heading', { name: 'Rappels de rendez-vous' })).not.toBeInTheDocument();
    expect(state.calls).toEqual([`/patients/${PATIENT}`]);
  });
  it('lecture seule avec consent:read', async () => {
    state.permissions.push('patients:consent:read');
    state.routes.set(`/patients/${PATIENT}/contact-consents`, CONSENTS);
    await render_();
    expect(screen.getByRole('heading', { name: 'Rappels de rendez-vous' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /consentement/ })).not.toBeInTheDocument();
  });
  it('modifiable avec consent:create', async () => {
    state.permissions.push('patients:consent:read', 'patients:consent:create');
    state.routes.set(`/patients/${PATIENT}/contact-consents`, CONSENTS);
    await render_();
    expect(screen.getByRole('button', { name: 'Révoquer le consentement SMS' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accorder le consentement E-mail' })).toBeInTheDocument();
  });
  it('erreur de l\'API : le reste de la fiche reste affiché', async () => {
    state.permissions.push('patients:consent:read');
    state.routes.set(`/patients/${PATIENT}/contact-consents`, new ApiError({ status: 403, code: 'x' }));
    await render_();
    expect(screen.getByRole('alert')).toHaveTextContent('Rappels de rendez-vous');
    expect(screen.getByRole('heading', { name: /Awa/ })).toBeInTheDocument();
  });
});
