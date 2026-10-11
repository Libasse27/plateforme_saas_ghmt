import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractClientInfo, forwardHeaders } from './client-info';

/** En-têtes simulés (l'objet Headers refuse les caractères de contrôle que l'on veut justement tester). */
const h = (init: Record<string, string>): Pick<Headers, 'get'> => ({ get: (name: string) => init[name.toLowerCase()] ?? null });
const SECRET = 'S'.repeat(40);

afterEach(() => vi.unstubAllEnvs());

describe('extractClientInfo : profondeur de proxy (docs/11 D11)', () => {
  it('avec 1 proxy, retient la dernière entrée de x-forwarded-for (celle ajoutée par le proxy)', () => {
    expect(extractClientInfo(h({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }), { hops: 1 }).ip).toBe('203.0.113.9');
  });
  it('avec 2 proxys, retient l’avant-dernière entrée', () => {
    expect(extractClientInfo(h({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.0.0.2' }), { hops: 2 }).ip).toBe('203.0.113.9');
  });
  it('n’accorde aucune confiance aux entrées antérieures, fournies par le navigateur', () => {
    expect(extractClientInfo(h({ 'x-forwarded-for': '10.1.1.1, 10.2.2.2, 203.0.113.9' }), { hops: 1 }).ip).toBe('203.0.113.9');
  });
  it('chaîne plus courte que le nombre de proxys : aucune IP', () => {
    expect(extractClientInfo(h({ 'x-forwarded-for': '203.0.113.9' }), { hops: 2 }).ip).toBeUndefined();
    expect(extractClientInfo(h({}), { hops: 1 }).ip).toBeUndefined();
  });
  it('aucun proxy de confiance (0) : l’en-tête n’est jamais cru', () => {
    expect(extractClientInfo(h({ 'x-forwarded-for': '203.0.113.9' }), { hops: 0 }).ip).toBeUndefined();
  });
  it('découpe et nettoie les entrées (espaces, casse IPv6)', () => {
    expect(extractClientInfo(h({ 'x-forwarded-for': '  6.6.6.6 ,   203.0.113.9  ' }), { hops: 1 }).ip).toBe('203.0.113.9');
  });
  it('entrée retenue invalide : aucune IP, sans chercher une autre entrée', () => {
    expect(extractClientInfo(h({ 'x-forwarded-for': '203.0.113.9, pas-une-ip' }), { hops: 1 }).ip).toBeUndefined();
    expect(extractClientInfo(h({ 'x-forwarded-for': '203.0.113.9,' }), { hops: 1 }).ip).toBeUndefined();
    expect(extractClientInfo(h({ 'x-forwarded-for': '203.0.113.9:8080' }), { hops: 1 }).ip).toBeUndefined();
    expect(extractClientInfo(h({ 'x-forwarded-for': 'fe80::1%eth0' }), { hops: 1 }).ip).toBeUndefined();
  });
  it('accepte IPv6 et normalise les IPv4 encapsulées ::ffff:a.b.c.d', () => {
    expect(extractClientInfo(h({ 'x-forwarded-for': '2001:db8::1' }), { hops: 1 }).ip).toBe('2001:db8::1');
    expect(extractClientInfo(h({ 'x-forwarded-for': '::ffff:203.0.113.9' }), { hops: 1 }).ip).toBe('203.0.113.9');
    expect(extractClientInfo(h({ 'x-forwarded-for': '::FFFF:203.0.113.9' }), { hops: 1 }).ip).toBe('203.0.113.9');
  });
  it('ignore x-real-ip, y compris sans x-forwarded-for exploitable', () => {
    expect(extractClientInfo(h({ 'x-real-ip': '198.51.100.4' }), { hops: 1 }).ip).toBeUndefined();
    expect(extractClientInfo(h({ 'x-forwarded-for': 'n’importe quoi', 'x-real-ip': '198.51.100.4' }), { hops: 1 }).ip).toBeUndefined();
  });
  it('lit TRUSTED_PROXY_HOPS dans l’environnement par défaut (1 hors production)', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('TRUSTED_PROXY_HOPS', '');
    vi.stubEnv('EDGE_PROXY_SECRET', '');
    expect(extractClientInfo(h({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' })).ip).toBe('203.0.113.9');
    vi.stubEnv('TRUSTED_PROXY_HOPS', '2');
    expect(extractClientInfo(h({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9, 10.0.0.2' })).ip).toBe('203.0.113.9');
  });
});

describe('extractClientInfo : secret de bordure', () => {
  const xff = { 'x-forwarded-for': '203.0.113.9' };
  it('secret valide : l’IP est retenue', () => {
    expect(extractClientInfo(h({ ...xff, 'x-ghmt-edge-auth': SECRET }), { hops: 1, edgeSecret: SECRET }).ip).toBe('203.0.113.9');
  });
  it('secret absent, faux ou de longueur différente : aucune IP', () => {
    expect(extractClientInfo(h(xff), { hops: 1, edgeSecret: SECRET }).ip).toBeUndefined();
    expect(extractClientInfo(h({ ...xff, 'x-ghmt-edge-auth': 'X'.repeat(40) }), { hops: 1, edgeSecret: SECRET }).ip).toBeUndefined();
    expect(extractClientInfo(h({ ...xff, 'x-ghmt-edge-auth': 'court' }), { hops: 1, edgeSecret: SECRET }).ip).toBeUndefined();
  });
  it('lit EDGE_PROXY_SECRET dans l’environnement par défaut', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TRUSTED_PROXY_HOPS', '1');
    vi.stubEnv('EDGE_PROXY_SECRET', SECRET);
    expect(extractClientInfo(h(xff)).ip).toBeUndefined();
    expect(extractClientInfo(h({ ...xff, 'x-ghmt-edge-auth': SECRET })).ip).toBe('203.0.113.9');
  });
  it('conserve le User-Agent même sans bordure valide', () => {
    expect(extractClientInfo(h({ ...xff, 'user-agent': 'UA' }), { hops: 1, edgeSecret: SECRET })).toEqual({ ip: undefined, userAgent: 'UA' });
  });
});

describe('extractClientInfo : User-Agent', () => {
  it('conserve le User-Agent tronqué et nettoyé', () => {
    expect(extractClientInfo(h({ 'user-agent': 'Mozilla/5.0' }), { hops: 1 }).userAgent).toBe('Mozilla/5.0');
    expect(extractClientInfo(h({ 'user-agent': 'a'.repeat(1000) }), { hops: 1 }).userAgent).toHaveLength(300);
    expect(extractClientInfo(h({ 'user-agent': 'a\u0000b\nc' }), { hops: 1 }).userAgent).toBe('abc');
    expect(extractClientInfo(h({}), { hops: 1 }).userAgent).toBeUndefined();
  });
});

describe('forwardHeaders', () => {
  it('produit les en-têtes à transmettre à l’API', () => {
    expect(forwardHeaders({ ip: '1.2.3.4', userAgent: 'UA' })).toEqual({ 'x-forwarded-for': '1.2.3.4', 'user-agent': 'UA' });
    expect(forwardHeaders({})).toEqual({});
    expect(forwardHeaders(undefined)).toEqual({});
  });
  it('ne transmet jamais le secret de bordure', () => {
    const forwarded = forwardHeaders(extractClientInfo(h({ 'x-forwarded-for': '1.2.3.4', 'x-ghmt-edge-auth': SECRET }), { hops: 1, edgeSecret: SECRET }));
    expect(JSON.stringify(forwarded)).not.toContain(SECRET);
    expect(Object.keys(forwarded)).not.toContain('x-ghmt-edge-auth');
  });
});
