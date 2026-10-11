import { afterEach, describe, expect, it, vi } from 'vitest';
import { edgeSecretMatches, isFromTrustedEdge } from './edge';

const SECRET = 'E'.repeat(48);
const h = (init: Record<string, string>) => new Headers(init);

afterEach(() => vi.unstubAllEnvs());

describe('isFromTrustedEdge (docs/11 D11)', () => {
  it('hors production sans secret configuré : accès direct autorisé (développement)', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('EDGE_PROXY_SECRET', '');
    expect(isFromTrustedEdge(h({}))).toBe(true);
  });

  it('secret configuré : exige exactement la même valeur', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('EDGE_PROXY_SECRET', SECRET);
    expect(isFromTrustedEdge(h({ 'x-ghmt-edge-auth': SECRET }))).toBe(true);
    expect(isFromTrustedEdge(h({}))).toBe(false);
    expect(isFromTrustedEdge(h({ 'x-ghmt-edge-auth': '' }))).toBe(false);
    expect(isFromTrustedEdge(h({ 'x-ghmt-edge-auth': `${SECRET}x` }))).toBe(false);
    expect(isFromTrustedEdge(h({ 'x-ghmt-edge-auth': SECRET.slice(1) }))).toBe(false);
    expect(isFromTrustedEdge(h({ 'x-ghmt-edge-auth': 'F'.repeat(48) }))).toBe(false);
  });

  it('s’applique aussi hors production dès qu’un secret est configuré', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('EDGE_PROXY_SECRET', SECRET);
    expect(isFromTrustedEdge(h({}))).toBe(false);
    expect(isFromTrustedEdge(h({ 'x-ghmt-edge-auth': SECRET }))).toBe(true);
  });

  it('production sans secret valide : refuse tout (fermé par défaut)', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('EDGE_PROXY_SECRET', '');
    expect(isFromTrustedEdge(h({ 'x-ghmt-edge-auth': SECRET }))).toBe(false);
    vi.stubEnv('EDGE_PROXY_SECRET', 'trop-court');
    expect(isFromTrustedEdge(h({ 'x-ghmt-edge-auth': 'trop-court' }))).toBe(false);
  });

  it('compare en temps constant : des longueurs différentes ne provoquent aucune erreur (empreintes de même taille)', () => {
    expect(edgeSecretMatches('a', SECRET)).toBe(false);
    expect(edgeSecretMatches(SECRET.repeat(3), SECRET)).toBe(false);
    expect(edgeSecretMatches(SECRET, SECRET)).toBe(true);
    expect(edgeSecretMatches(null, SECRET)).toBe(false);
    expect(edgeSecretMatches(undefined, SECRET)).toBe(false);
  });
});
