// @vitest-environment node
import { NextRequest, type NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRefreshCache } from '@/lib/api/refresh';
import { jsonResponse, okEnvelope, problem } from '@/lib/api/test-helpers';
import { isFromTrustedEdge } from '@/lib/edge';
import { config, proxy } from './proxy';

vi.mock('@/lib/edge', () => ({ isFromTrustedEdge: vi.fn(() => true) }));

function req(path: string, cookie?: string, method = 'GET'): NextRequest {
  return new NextRequest(`http://localhost:3001${path}`, { method, headers: cookie ? { cookie } : {} });
}

beforeEach(() => {
  vi.mocked(isFromTrustedEdge).mockReturnValue(true);
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


const REQUEST_HEADER_PREFIX = 'x-middleware-request-';

function requestHeader(res: NextResponse, name: string): string | null {
  return res.headers.get(`${REQUEST_HEADER_PREFIX}${name}`);
}

function nonceOf(policy: string | null): string | undefined {
  return /'nonce-([^']+)'/.exec(policy ?? '')?.[1];
}

describe('proxy : nouvelles routes publiques (docs/11 §9.2)', () => {
  it('laisse passer le mot de passe oublié, la réinitialisation et la vérification d\'inscription sans session', async () => {
    const paths = ['/mot-de-passe-oublie', '/reinitialiser/abc.def', '/inscription/verifier', '/inscription/confirmer/abc.def'];
    for (const path of paths) {
      const res = await proxy(req(path));
      expect(res.headers.get('location'), path).toBeNull();
      expect(res.headers.get('x-middleware-next'), path).toBe('1');
    }
  });

  it('une page de réinitialisation reste accessible à un utilisateur connecté (aucune redirection vers l\'accueil)', async () => {
    const res = await proxy(req('/reinitialiser/abc.def', 'ghmt_at=a'));
    expect(res.headers.get('location')).toBeNull();
  });
});

describe('proxy : CSP à nonces (docs/11 D14)', () => {
  it('pose la CSP sur la réponse et sur l\'en-tête de requête, avec le même nonce et x-nonce', async () => {
    const res = await proxy(req('/patients', 'ghmt_at=a'));
    const policy = res.headers.get('content-security-policy');
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    const nonce = nonceOf(policy);
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(requestHeader(res, 'content-security-policy')).toBe(policy);
    expect(requestHeader(res, 'x-nonce')).toBe(nonce);
  });

  it('génère un nonce différent à chaque requête', async () => {
    const nonces = new Set<string | undefined>();
    for (let i = 0; i < 5; i += 1) nonces.add(nonceOf((await proxy(req('/connexion'))).headers.get('content-security-policy')));
    expect(nonces.size).toBe(5);
  });

  it('pose la CSP sur les pages publiques', async () => {
    expect((await proxy(req('/connexion'))).headers.get('content-security-policy')).toContain("'strict-dynamic'");
  });

  it('pose la CSP sur les redirections (garde de session et utilisateur déjà connecté)', async () => {
    const toLogin = await proxy(req('/patients'));
    expect(toLogin.status).toBe(307);
    expect(toLogin.headers.get('content-security-policy')).toContain("'nonce-");
    const toHome = await proxy(req('/connexion', 'ghmt_at=a'));
    expect(toHome.status).toBe(307);
    expect(toHome.headers.get('content-security-policy')).toContain("'nonce-");
  });

  it('pose la CSP après un rafraîchissement silencieux, en conservant les cookies renouvelés dans la requête', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => okEnvelope({ accessToken: 'new-a', refreshToken: 'new-r', expiresIn: 900 })));
    const res = await proxy(req('/patients', 'ghmt_rt=old-r'));
    expect(res.headers.get('content-security-policy')).toContain("'nonce-");
    expect(requestHeader(res, 'x-nonce')).toBeTruthy();
    expect(res.headers.getSetCookie().join('\n')).toContain('ghmt_at=new-a');
  });

  it('CSP_MODE=report-only : en-tête Report-Only seul, jamais les deux', async () => {
    vi.stubEnv('CSP_MODE', 'report-only');
    const res = await proxy(req('/patients', 'ghmt_at=a'));
    expect(res.headers.get('content-security-policy-report-only')).toContain("default-src 'self'");
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(requestHeader(res, 'content-security-policy-report-only')).toBe(res.headers.get('content-security-policy-report-only'));
  });

  it('CSP_REPORT_URI : report-uri/report-to et Reporting-Endpoints', async () => {
    vi.stubEnv('CSP_REPORT_URI', 'https://collect.example.org/csp');
    const res = await proxy(req('/connexion'));
    expect(res.headers.get('content-security-policy')).toContain('report-uri https://collect.example.org/csp; report-to csp-endpoint');
    expect(res.headers.get('reporting-endpoints')).toBe('csp-endpoint="https://collect.example.org/csp"');
  });

  it('CSP_FORM_ACTION_ORIGINS : origines de form-action (passerelle de paiement)', async () => {
    vi.stubEnv('CSP_FORM_ACTION_ORIGINS', 'https://pay.cinetpay.test');
    const policy = (await proxy(req('/abonnement', 'ghmt_at=a'))).headers.get('content-security-policy');
    expect(policy).toContain("form-action 'self' https://pay.cinetpay.test");
  });

  it('autorise unsafe-eval uniquement en développement', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    expect((await proxy(req('/connexion'))).headers.get('content-security-policy')).toContain("'unsafe-eval'");
    vi.stubEnv('NODE_ENV', 'production');
    expect((await proxy(req('/connexion'))).headers.get('content-security-policy')).not.toContain('unsafe-eval');
  });
});

describe('proxy : mise en cache', () => {
  it('no-store sur les pages non publiques (suite, redirections comprises)', async () => {
    expect((await proxy(req('/patients', 'ghmt_at=a'))).headers.get('cache-control')).toBe('private, no-store');
    expect((await proxy(req('/patients'))).headers.get('cache-control')).toBe('private, no-store');
    expect((await proxy(req('/plateforme/plans', 'ghmt_pat=pa'))).headers.get('cache-control')).toBe('private, no-store');
  });

  it('no-store aussi sur les pages publiques qui portent un jeton dans l\'URL', async () => {
    for (const path of ['/reinitialiser/abc.def', '/inscription/confirmer/abc.def', '/invitation/abc.def']) {
      expect((await proxy(req(path))).headers.get('cache-control'), path).toBe('private, no-store');
    }
  });
});

describe('proxy : garde du proxy de bordure (docs/11 D11)', () => {
  it('répond 403 en texte brut en production quand la requête ne vient pas du proxy de bordure', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.mocked(isFromTrustedEdge).mockReturnValue(false);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await proxy(req('/patients', 'ghmt_rt=old'));
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await res.text()).not.toMatch(/secret|EDGE/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuse aussi les pages publiques', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.mocked(isFromTrustedEdge).mockReturnValue(false);
    expect((await proxy(req('/connexion'))).status).toBe(403);
  });

  it('hors production, la garde n\'est pas appliquée', async () => {
    vi.mocked(isFromTrustedEdge).mockReturnValue(false);
    expect((await proxy(req('/connexion'))).status).toBe(200);
  });

  it('en production, laisse passer une requête dont l\'en-tête de bordure est valide', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SESSION_COOKIE_SECURE', 'false');
    expect((await proxy(req('/connexion'))).status).toBe(200);
  });
});

describe('proxy : matcher (revue H1)', () => {
  // Le matcher est une expression de chemin à un seul groupe ; on l'évalue comme Next le fait (ancrée).
  const source = config.matcher[0] as string;
  const matches = (path: string): boolean => new RegExp(`^${source}$`).test(path);
  const UUID = '0190a3b2-7c11-7a55-9e0f-3a1b2c3d4e5f';
  const SECRET = 'abcdefghijklmnopqrstuvwxyz0123456789_-ABCDEF';

  it('couvre les chemins à jeton « <uuid>.<secret> », qui contiennent un point', () => {
    expect(matches(`/reinitialiser/${UUID}.${SECRET}`)).toBe(true);
    expect(matches(`/inscription/confirmer/${UUID}.${SECRET}`)).toBe(true);
    expect(matches(`/invitation/${UUID}.${SECRET}`)).toBe(true);
  });

  it('couvre un jeton dont le secret ressemble à une extension statique', () => {
    expect(matches(`/reinitialiser/${UUID}.svg-abcdefghijklmnopqrst`)).toBe(true);
  });

  it('couvre les pages ordinaires', () => {
    for (const path of ['/', '/connexion', '/patients/abc', '/plateforme/plans', '/administration/securite']) expect(matches(path), path).toBe(true);
  });

  it('exclut les ressources statiques', () => {
    for (const path of ['/_next/static/chunks/app.js', '/_next/image', '/favicon.ico', '/logo.svg', '/img/photo.png', '/fonts/a.woff2', '/robots.txt']) {
      expect(matches(path), path).toBe(false);
    }
  });
});
