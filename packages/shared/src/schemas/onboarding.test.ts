import { describe, expect, it } from 'vitest';
import {
  PENDING_SIGNUP_EXPIRY_DAYS,
  RESERVED_SLUG_PREFIXES,
  RESERVED_TENANT_SLUGS,
  SIGNUP_VERIFICATION_TTL_HOURS,
  isReservedTenantSlug,
  resendSignupVerificationSchema,
  verifySignupSchema,
} from './onboarding';
import { tenantSlug } from './primitives';

const VALID_TOKEN = `0198a2b4-7c3d-7e11-8a52-3f6d2c9b1e04.${'A'.repeat(43)}`;

describe('slugs réservés (docs/11 D13)', () => {
  it.each(['www', 'admin', 'api', 'plateforme', 'null', 'undefined', 'sandbox', 'securite'])('réserve « %s »', (slug) => {
    expect(isReservedTenantSlug(slug)).toBe(true);
  });

  it('ignore la casse et les espaces', () => {
    expect(isReservedTenantSlug('ADMIN')).toBe(true);
    expect(isReservedTenantSlug('  Api ')).toBe(true);
  });

  it.each(['xn--abc', 'xn--', 'ghmt', 'ghmt-prod', 'ghmtclinique'])('réserve le préfixe de « %s »', (slug) => {
    expect(isReservedTenantSlug(slug)).toBe(true);
  });

  it.each(['clinique-du-lac', 'hopital-central', 'admin-clinique', 'monghmt', 'wwwclinique'])('laisse libre « %s »', (slug) => {
    expect(isReservedTenantSlug(slug)).toBe(false);
  });

  it('ne contient que des slugs valides et uniques, et chaque entrée est réservée', () => {
    expect(new Set(RESERVED_TENANT_SLUGS).size).toBe(RESERVED_TENANT_SLUGS.length);
    for (const slug of RESERVED_TENANT_SLUGS) expect(isReservedTenantSlug(slug)).toBe(true);
    // Les entrées trop courtes pour un slug (< 3) ne seraient de toute façon jamais inscriptibles ; on le sait.
    for (const slug of RESERVED_TENANT_SLUGS) expect(slug).toMatch(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
  });

  it('couvre la liste minimale du contrat', () => {
    expect(RESERVED_TENANT_SLUGS).toEqual(
      expect.arrayContaining(['www', 'api', 'app', 'admin', 'administration', 'plateforme', 'platform', 'console', 'support', 'aide', 'help', 'status', 'statut', 'mail', 'smtp', 'imap', 'static', 'assets', 'cdn', 'docs', 'blog', 'auth', 'login', 'connexion', 'inscription', 'signup', 'compte', 'account', 'billing', 'facturation', 'paiement', 'payment', 'security', 'securite', 'dev', 'staging', 'preprod', 'prod', 'test', 'demo', 'sandbox', 'internal', 'system', 'root', 'null', 'undefined']),
    );
    expect(RESERVED_SLUG_PREFIXES).toEqual(['xn--', 'ghmt']);
  });

  it('reste cohérent avec le schéma de slug (les valeurs de plus de 3 caractères passent la validation de forme)', () => {
    expect(tenantSlug.safeParse('admin').success).toBe(true);
  });
});

describe('constantes', () => {
  it('fixe les durées du contrat', () => {
    expect(SIGNUP_VERIFICATION_TTL_HOURS).toBe(24);
    expect(PENDING_SIGNUP_EXPIRY_DAYS).toBe(7);
  });
});

describe('verifySignupSchema', () => {
  it('accepte un jeton bien formé', () => {
    expect(verifySignupSchema.parse({ token: VALID_TOKEN })).toEqual({ token: VALID_TOKEN });
  });

  it.each(['', 'court', `${'x'.repeat(40)}`, `${VALID_TOKEN}!`, 'a'.repeat(300)])('refuse un jeton mal formé (%#)', (token) => {
    expect(verifySignupSchema.safeParse({ token }).success).toBe(false);
  });

  it('refuse un corps sans jeton ou de type invalide', () => {
    expect(verifySignupSchema.safeParse({}).success).toBe(false);
    expect(verifySignupSchema.safeParse({ token: 42 }).success).toBe(false);
    expect(verifySignupSchema.safeParse(null).success).toBe(false);
  });
});

describe('resendSignupVerificationSchema', () => {
  it('normalise le code établissement et l’e-mail en minuscules', () => {
    const parsed = resendSignupVerificationSchema.parse({ tenantSlug: 'clinique-test', email: 'Admin@Clinique.TEST' });
    expect(parsed).toEqual({ tenantSlug: 'clinique-test', email: 'admin@clinique.test' });
  });

  it.each([
    [{ tenantSlug: 'x', email: 'a@b.test' }],
    [{ tenantSlug: 'clinique', email: 'pas-un-email' }],
    [{ tenantSlug: 'clinique' }],
    [{}],
  ])('refuse un corps invalide (%#)', (body) => {
    expect(resendSignupVerificationSchema.safeParse(body).success).toBe(false);
  });
});
