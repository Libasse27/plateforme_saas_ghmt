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
  apiDeps: vi.fn(),
  pageApi: async (path: string) => {
    state.calls.push(path);
    const route = state.routes.get(path);
    if (route instanceof Error) throw route;
    if (route === undefined) throw new ApiError({ status: 404, code: 'not_found' });
    return { data: route, meta: {}, status: 200 };
  },
}));

import PatientPage from '../page';

const DOCUMENTS = {
  items: [
    {
      id: '0192f0a0-0000-7000-8000-000000000001',
      purpose: 'identity',
      status: 'pending',
      originalName: 'Carte.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 2048,
      createdAt: '2026-10-11T10:00:00.000Z',
      createdBy: { id: '0192f0a0-0000-7000-8000-000000000002', fullName: 'Awa Diop' },
    },
  ],
};

beforeEach(() => {
  state.permissions = ['patients:patient:read'];
  state.routes.clear();
  state.calls.length = 0;
  state.routes.set(`/patients/${PATIENT}`, { id: PATIENT, firstName: 'Awa', lastName: 'Diop' });
});

const render_ = async () => render(await PatientPage({ params: Promise.resolve({ id: PATIENT }) }));

describe('bloc « Documents » de la fiche patient (docs/13 §9)', () => {
  it('absent et sans appel sans la permission patients:identity_doc:read', async () => {
    await render_();

    expect(screen.queryByRole('heading', { name: 'Documents' })).not.toBeInTheDocument();
    expect(state.calls).toEqual([`/patients/${PATIENT}`]);
  });

  it('lecture seule avec identity_doc:read : liste, « Analyse en cours », ni dépôt ni suppression', async () => {
    state.permissions.push('patients:identity_doc:read');
    state.routes.set(`/patients/${PATIENT}/documents`, DOCUMENTS);

    await render_();

    expect(screen.getByRole('heading', { name: 'Documents' })).toBeInTheDocument();
    expect(screen.getByText('Analyse en cours')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Déposer le document' })).not.toBeInTheDocument();
    expect(screen.queryByText('Supprimer')).not.toBeInTheDocument();
  });

  it('dépôt avec identity_doc:create, suppression avec identity_doc:delete', async () => {
    state.permissions.push('patients:identity_doc:read', 'patients:identity_doc:create', 'patients:identity_doc:delete');
    state.routes.set(`/patients/${PATIENT}/documents`, DOCUMENTS);

    await render_();

    expect(screen.getByRole('button', { name: 'Déposer le document' })).toBeInTheDocument();
    expect(screen.getByText('Supprimer')).toBeInTheDocument();
  });

  it('erreur de l’API : message dans le bloc, le reste de la fiche reste affiché', async () => {
    state.permissions.push('patients:identity_doc:read');
    state.routes.set(`/patients/${PATIENT}/documents`, new ApiError({ status: 403, code: 'x' }));

    await render_();

    expect(screen.getByRole('alert')).toHaveTextContent('Documents');
    expect(screen.getByRole('heading', { name: /Awa/ })).toBeInTheDocument();
  });
});
