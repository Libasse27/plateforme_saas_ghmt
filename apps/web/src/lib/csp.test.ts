import { describe, expect, it } from 'vitest';
import { buildContentSecurityPolicy, cspHeaderName, generateNonce, readCspConfig } from './csp';

const NONCE = 'AAAAAAAAAAAAAAAAAAAAAA==';

function directives(policy: string): Map<string, string> {
  return new Map(
    policy
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name = '', ...values] = part.split(/\s+/);
        return [name, values.join(' ')] as const;
      }),
  );
}

describe('generateNonce', () => {
  it('produit 16 octets en base64 (24 caractères, 128 bits)', () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(Buffer.from(nonce, 'base64')).toHaveLength(16);
  });

  it('est différent à chaque appel', () => {
    const nonces = new Set(Array.from({ length: 200 }, () => generateNonce()));
    expect(nonces.size).toBe(200);
  });
});

describe('buildContentSecurityPolicy', () => {
  const production = { nonce: NONCE, dev: false } as const;

  it('produit les directives exactes de la production (docs/11 D14)', () => {
    const policy = directives(buildContentSecurityPolicy(production));
    expect(Object.fromEntries(policy)).toEqual({
      'default-src': "'self'",
      'script-src': `'self' 'nonce-${NONCE}' 'strict-dynamic'`,
      'style-src': `'self' 'nonce-${NONCE}'`,
      'img-src': "'self' data: blob:",
      'font-src': "'self'",
      'connect-src': "'self'",
      'object-src': "'none'",
      'base-uri': "'none'",
      'frame-src': "'none'",
      'frame-ancestors': "'none'",
      'form-action': "'self'",
      'manifest-src': "'self'",
      'worker-src': "'self'",
      'upgrade-insecure-requests': '',
    });
  });

  it('n\'autorise jamais unsafe-inline ni unsafe-eval en production', () => {
    const policy = buildContentSecurityPolicy(production);
    expect(policy).not.toContain('unsafe-inline');
    expect(policy).not.toContain('unsafe-eval');
  });

  it('ajoute unsafe-eval et ws: en développement, sans upgrade-insecure-requests', () => {
    const policy = directives(buildContentSecurityPolicy({ nonce: NONCE, dev: true }));
    expect(policy.get('script-src')).toBe(`'self' 'nonce-${NONCE}' 'strict-dynamic' 'unsafe-eval'`);
    expect(policy.get('connect-src')).toBe("'self' ws:");
    expect(policy.has('upgrade-insecure-requests')).toBe(false);
  });

  it('ajoute les origines https de form-action (passerelles de paiement)', () => {
    const policy = directives(buildContentSecurityPolicy({ ...production, formActionOrigins: ['https://pay.cinetpay.test', 'https://secure.example.org'] }));
    expect(policy.get('form-action')).toBe("'self' https://pay.cinetpay.test https://secure.example.org");
  });

  it('écarte les origines non https, mal formées ou porteuses d\'injection de directive', () => {
    const policy = directives(
      buildContentSecurityPolicy({
        ...production,
        formActionOrigins: ['http://pay.test', 'javascript:alert(1)', "https://a.test; script-src *", '*', '', 'https://ok.test/chemin?x=1', 'https://ok.test'],
      }),
    );
    expect(policy.get('form-action')).toBe("'self' https://ok.test");
  });

  it('ajoute report-uri et report-to quand un collecteur https est configuré', () => {
    const policy = directives(buildContentSecurityPolicy({ ...production, reportUri: 'https://collect.example.org/csp' }));
    expect(policy.get('report-uri')).toBe('https://collect.example.org/csp');
    expect(policy.get('report-to')).toBe('csp-endpoint');
  });

  it('ignore un collecteur non https ou contenant des séparateurs', () => {
    for (const reportUri of ['http://collect.test/csp', 'https://c.test/x; script-src *', 'https://c.test/a b', 'pas une url']) {
      const policy = directives(buildContentSecurityPolicy({ ...production, reportUri }));
      expect(policy.has('report-uri')).toBe(false);
      expect(policy.has('report-to')).toBe(false);
    }
  });

  it('refuse un nonce qui ne serait pas du base64 (anti-injection)', () => {
    expect(() => buildContentSecurityPolicy({ nonce: "x'; script-src *", dev: false })).toThrow(/nonce/i);
  });
});

describe('readCspConfig', () => {
  it('applique les défauts : enforce, aucun collecteur, aucune origine', () => {
    expect(readCspConfig({})).toEqual({ mode: 'enforce', reportUri: undefined, formActionOrigins: [] });
  });

  it('lit CSP_MODE=report-only, le collecteur et la liste d\'origines séparées par des virgules', () => {
    expect(
      readCspConfig({ CSP_MODE: ' report-only ', CSP_REPORT_URI: ' https://c.test/csp ', CSP_FORM_ACTION_ORIGINS: 'https://a.test, https://b.test ,,' }),
    ).toEqual({ mode: 'report-only', reportUri: 'https://c.test/csp', formActionOrigins: ['https://a.test', 'https://b.test'] });
  });

  it('retombe sur enforce pour toute valeur inconnue (jamais d\'affaiblissement silencieux)', () => {
    expect(readCspConfig({ CSP_MODE: 'off' }).mode).toBe('enforce');
    expect(readCspConfig({ CSP_MODE: '' }).mode).toBe('enforce');
  });

  it('traite une variable vide comme absente', () => {
    expect(readCspConfig({ CSP_REPORT_URI: '  ', CSP_FORM_ACTION_ORIGINS: '' })).toEqual({ mode: 'enforce', reportUri: undefined, formActionOrigins: [] });
  });
});

describe('cspHeaderName', () => {
  it('choisit l\'en-tête selon le mode', () => {
    expect(cspHeaderName('enforce')).toBe('Content-Security-Policy');
    expect(cspHeaderName('report-only')).toBe('Content-Security-Policy-Report-Only');
  });
});
