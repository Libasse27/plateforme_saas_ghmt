import { beforeEach, describe, expect, it, vi } from 'vitest';

class Redirect extends Error {
  constructor(readonly url: string) {
    super(`REDIRECT:${url}`);
  }
}
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
}));

const publicRequest = vi.fn();
vi.mock('@/server/api', () => ({
  publicRequest: (...args: unknown[]) => publicRequest(...args),
}));

import { acceptInvitationAction } from './invitation';
import { EMPTY_FORM_STATE } from '@/lib/forms';

const TOKEN = 'c440ccb8-afa1-4bd3-9dcf-5be074f30cb2.mzo4rdtPC8y_mbIQyaBvTlq0rgTGPyW5A1vNJ1OTFBU';
const PASSWORD = 'Caisse-Thies-2026!';

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function redirectOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  if (!(error instanceof Redirect)) throw new Error('redirection attendue');
  return error.url;
}

beforeEach(() => {
  publicRequest.mockReset();
  publicRequest.mockResolvedValue({ data: null });
});

describe('acceptInvitationAction', () => {
  it('après acceptation, pré-remplit le code établissement sur la page de connexion', async () => {
    const url = await redirectOf(acceptInvitationAction(EMPTY_FORM_STATE, form({ token: TOKEN, tenantSlug: 'parcours-web-01', password: PASSWORD, confirmPassword: PASSWORD })));
    expect(url).toBe('/connexion?invitation=acceptee&etablissement=parcours-web-01');
    expect(publicRequest).toHaveBeenCalledWith(`/auth/invitations/${TOKEN}/accept`, { method: 'POST', body: { password: PASSWORD } });
  });

  it('ignore un code établissement mal formé (aucune injection dans l\'URL de redirection)', async () => {
    for (const tenantSlug of ['', 'A&b=c', '../x', 'a'.repeat(60)]) {
      const url = await redirectOf(acceptInvitationAction(EMPTY_FORM_STATE, form({ token: TOKEN, tenantSlug, password: PASSWORD, confirmPassword: PASSWORD })));
      expect(url).toBe('/connexion?invitation=acceptee');
    }
  });

  it('mots de passe différents : erreur de champ, aucun appel', async () => {
    const state = await acceptInvitationAction(EMPTY_FORM_STATE, form({ token: TOKEN, tenantSlug: 'parcours-web-01', password: PASSWORD, confirmPassword: 'autre-chose-123' }));
    expect(state.fieldErrors?.confirmPassword).toBeDefined();
    expect(publicRequest).not.toHaveBeenCalled();
  });
});
