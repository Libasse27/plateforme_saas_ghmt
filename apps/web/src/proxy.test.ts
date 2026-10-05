// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRefreshCache } from '@/lib/api/refresh';
import { jsonResponse, okEnvelope, problem } from '@/lib/api/test-helpers';
import { proxy } from './proxy';

function req(path: string, cookie?: string, method = 'GET'): NextRequest {
  return new NextRequest(`http://localhost:3001${path}`, { method, headers: cookie ? { cookie } : {} });
}

beforeEach(() => {
  vi.stubEnv('SESSION_COOKIE_SECURE', 'false');
  vi.stubEnv('API_URL', 'http://api.test/api/v1');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetRefreshCache();
});

describe('proxy', () => {
  it('redirige vers /connexion?next=… sans session', async () => {
    const res = await proxy(req('/patients?q=a'));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.pathname).toBe('/connexion');
    expect(location.searchParams.get('next')).toBe('/patients?q=a');
  });

  it('ne met pas next pour la racine', async () => {
    const location = new URL((await proxy(req('/'))).headers.get('location') ?? '');
    expect(location.searchParams.has('next')).toBe(false);
  });

  it('laisse passer une requête avec jeton d\'accès', async () => {
    const res = await proxy(req('/patients', 'ghmt_at=a'));
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('laisse passer les pages publiques', async () => {
    for (const path of ['/connexion', '/connexion/mfa', '/inscription', '/session/expire', '/invitation/abc.def']) {
      expect((await proxy(req(path))).headers.get('location')).toBeNull();
    }
  });

  it('renvoie un utilisateur connecté de /connexion vers l\'accueil (GET seulement)', async () => {
    const res = await proxy(req('/connexion', 'ghmt_at=a'));
    expect(new URL(res.headers.get('location') ?? '').pathname).toBe('/');
    const post = await proxy(req('/connexion', 'ghmt_at=a', 'POST'));
    expect(post.headers.get('location')).toBeNull();
  });

  it('rafraîchit en silence quand seul le refresh token reste et pose les nouveaux cookies httpOnly', async () => {
    const fetchMock = vi.fn(async () => okEnvelope({ accessToken: 'new-a', refreshToken: 'new-r', expiresIn: 900 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await proxy(req('/patients', 'ghmt_rt=old-r'));
    expect(res.headers.get('location')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const setCookie = res.headers.getSetCookie().join('\n');
    expect(setCookie).toContain('ghmt_at=new-a');
    expect(setCookie).toContain('ghmt_rt=new-r');
    expect(setCookie).toMatch(/HttpOnly/i);
  });

  it('purge la session quand le refresh token est refusé', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => problem(401, 'invalid_refresh_token')));
    const res = await proxy(req('/', 'ghmt_rt=revoked'));
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('session')).toBe('expiree');
    expect(res.headers.getSetCookie().join('\n')).toContain('ghmt_rt=;');
  });

  it('conserve les cookies lors d\'une panne réseau du refresh', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('down');
    }));
    const res = await proxy(req('/', 'ghmt_rt=still-valid'));
    expect(res.status).toBe(307);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('utilise les cookies __Host- en mode sécurisé', async () => {
    vi.stubEnv('SESSION_COOKIE_SECURE', 'true');
    const res = await proxy(req('/patients', '__Host-ghmt_at=a'));
    expect(res.headers.get('location')).toBeNull();
    const withoutPrefix = await proxy(req('/patients', 'ghmt_at=a'));
    expect(withoutPrefix.status).toBe(307);
  });

  it('jsonResponse reste utilisable pour les erreurs non enveloppées', () => {
    expect(jsonResponse(500, {}).status).toBe(500);
  });

  it('C9 : le rafraîchissement transmet l\'IP du proxy amont et le User-Agent', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => okEnvelope({ accessToken: 'a', refreshToken: 'r' }));
    vi.stubGlobal('fetch', fetchMock);
    const request = new NextRequest('http://localhost:3001/patients', {
      headers: { cookie: 'ghmt_rt=old-r', 'x-forwarded-for': '6.6.6.6, 203.0.113.9', 'user-agent': 'UA-test' },
    });
    await proxy(request);
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['x-forwarded-for']).toBe('203.0.113.9');
    expect(headers['user-agent']).toBe('UA-test');
  });
});

describe('proxy : espace plateforme séparé', () => {
  it('redirige /plateforme/* vers /plateforme/connexion sans session plateforme', async () => {
    const res = await proxy(req('/plateforme/factures?status=open'));
    expect(res.status).toBe(307);
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.pathname).toBe('/plateforme/connexion');
    expect(location.searchParams.get('next')).toBe('/plateforme/factures?status=open');
  });

  it('ne met pas next pour la racine de la console plateforme', async () => {
    const location = new URL((await proxy(req('/plateforme'))).headers.get('location') ?? '');
    expect(location.pathname).toBe('/plateforme/connexion');
    expect(location.searchParams.has('next')).toBe(false);
  });

  it('une session établissement ne donne jamais accès à /plateforme/*', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const cookie of ['ghmt_at=tenant-access', 'ghmt_rt=tenant-refresh', 'ghmt_at=a; ghmt_rt=r', '__Host-ghmt_at=a']) {
      const res = await proxy(req('/plateforme/etablissements', cookie));
      expect(new URL(res.headers.get('location') ?? '').pathname).toBe('/plateforme/connexion');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('une session plateforme ne donne pas accès à la console établissement', async () => {
    const res = await proxy(req('/patients', 'ghmt_pat=platform-access; ghmt_prt=p.refresh'));
    expect(new URL(res.headers.get('location') ?? '').pathname).toBe('/connexion');
  });

  it('laisse passer /plateforme/* avec un jeton d\'accès plateforme', async () => {
    const res = await proxy(req('/plateforme/plans', 'ghmt_pat=pa'));
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('x-middleware-next')).toBe('1');
  });

  it('laisse passer les pages publiques de la console plateforme', async () => {
    for (const path of ['/plateforme/connexion', '/plateforme/connexion/mfa', '/plateforme/session/expire']) {
      expect((await proxy(req(path))).headers.get('location')).toBeNull();
    }
  });

  it('renvoie un administrateur connecté de /plateforme/connexion vers son tableau de bord (GET seulement)', async () => {
    const res = await proxy(req('/plateforme/connexion', 'ghmt_pat=pa'));
    expect(new URL(res.headers.get('location') ?? '').pathname).toBe('/plateforme');
    expect((await proxy(req('/plateforme/connexion', 'ghmt_pat=pa', 'POST'))).headers.get('location')).toBeNull();
    expect((await proxy(req('/plateforme/connexion/mfa', 'ghmt_pat=pa'))).headers.get('location')).toBeNull();
  });

  it('rafraîchit via /platform/auth/refresh et pose les cookies plateforme (pas ceux de l\'établissement)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => okEnvelope({ accessToken: 'new-pa', refreshToken: 'p.new', expiresIn: 600 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await proxy(req('/plateforme', 'ghmt_prt=p.old-refresh-token-1'));
    expect(res.headers.get('location')).toBeNull();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://api.test/api/v1/platform/auth/refresh');
    const setCookie = res.headers.getSetCookie().join('\n');
    expect(setCookie).toContain('ghmt_pat=new-pa');
    expect(setCookie).toContain('ghmt_prt=p.new');
    expect(setCookie).not.toContain('ghmt_at=');
    expect(setCookie).toMatch(/HttpOnly/i);
  });

  it('purge uniquement la session plateforme quand le refresh est refusé', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => problem(401, 'unauthenticated')));
    const res = await proxy(req('/plateforme', 'ghmt_prt=p.revoked-token-12345; ghmt_rt=tenant'));
    const location = new URL(res.headers.get('location') ?? '');
    expect(location.pathname).toBe('/plateforme/connexion');
    expect(location.searchParams.get('session')).toBe('expiree');
    const setCookie = res.headers.getSetCookie().join('\n');
    expect(setCookie).toContain('ghmt_prt=;');
    expect(setCookie).not.toContain('ghmt_rt=;');
  });

  it('conserve la session plateforme lors d\'une panne réseau du refresh', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('down');
    }));
    const res = await proxy(req('/plateforme', 'ghmt_prt=p.still-valid-token-1'));
    expect(res.status).toBe(307);
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it('utilise les cookies __Host- plateforme en mode sécurisé', async () => {
    vi.stubEnv('SESSION_COOKIE_SECURE', 'true');
    expect((await proxy(req('/plateforme', '__Host-ghmt_pat=a'))).headers.get('location')).toBeNull();
    expect((await proxy(req('/plateforme', 'ghmt_pat=a'))).status).toBe(307);
  });

  it('la page sandbox de paiement est publique (hors production, le 404 est rendu par la page)', async () => {
    expect((await proxy(req('/sandbox/paiement/ref-12345678'))).headers.get('location')).toBeNull();
  });
});

