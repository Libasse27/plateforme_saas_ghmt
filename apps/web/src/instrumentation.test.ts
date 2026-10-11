import { afterEach, describe, expect, it, vi } from 'vitest';
import { register } from './instrumentation';

afterEach(() => vi.unstubAllEnvs());

describe('instrumentation : validation de la configuration de bordure au démarrage', () => {
  it('échoue immédiatement en production sans TRUSTED_PROXY_HOPS ni EDGE_PROXY_SECRET', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('TRUSTED_PROXY_HOPS', '');
    vi.stubEnv('EDGE_PROXY_SECRET', '');
    await expect(register()).rejects.toThrow(/TRUSTED_PROXY_HOPS|EDGE_PROXY_SECRET/);
  });

  it('échoue en production sans secret de bordure même si les sauts sont fournis', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('TRUSTED_PROXY_HOPS', '1');
    vi.stubEnv('EDGE_PROXY_SECRET', '');
    await expect(register()).rejects.toThrow(/EDGE_PROXY_SECRET/);
  });

  it('réussit en production avec une configuration complète', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('TRUSTED_PROXY_HOPS', '1');
    vi.stubEnv('EDGE_PROXY_SECRET', 'z'.repeat(40));
    await expect(register()).resolves.toBeUndefined();
  });

  it('réussit en développement sans variables', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_RUNTIME', 'nodejs');
    vi.stubEnv('TRUSTED_PROXY_HOPS', '');
    vi.stubEnv('EDGE_PROXY_SECRET', '');
    await expect(register()).resolves.toBeUndefined();
  });

  it('ne valide rien hors du runtime Node.js (Edge)', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEXT_RUNTIME', 'edge');
    vi.stubEnv('TRUSTED_PROXY_HOPS', '');
    await expect(register()).resolves.toBeUndefined();
  });
});
