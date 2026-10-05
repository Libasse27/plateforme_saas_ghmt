import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { ScopeType, SignupTenantInput } from '@ghmt/shared';
import { AccessTokenService } from '../../src/common/auth/access-token.service';
import { PasswordService } from '../../src/common/auth/password.service';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { TenantProvisioningService } from '../../src/infrastructure/tenancy/tenant-provisioning.service';

export const FIXTURE_PASSWORD = 'Motdepasse-solide-2026';
const SESSION_TTL_MS = 60 * 60 * 1000;

export interface TenantFixture {
  readonly tenantId: string;
  readonly slug: string;
  readonly adminUserId: string;
  readonly adminEmail: string;
  readonly mainSiteId: string;
  /** Jeton d'accès de l'administrateur, MFA considérée comme vérifiée. */
  readonly adminToken: string;
}

export interface UserFixture {
  readonly userId: string;
  readonly email: string;
  readonly token: string;
}

function uniqueSlug(prefix: string): string {
  return `${prefix}-${randomBytes(4).toString('hex')}`;
}

export function signupInput(slug: string, overrides: Partial<SignupTenantInput['establishment']> = {}): SignupTenantInput {
  return {
    establishment: {
      slug,
      legalName: `Clinique ${slug}`,
      establishmentType: 'clinic',
      countryCode: 'SN',
      baseCurrency: 'XOF',
      timezone: 'Africa/Dakar',
      ...overrides,
    },
    mainSite: { code: 'PRINC', name: 'Site principal', city: 'Dakar' },
    admin: { fullName: 'Admin Test', email: `admin@${slug}.test`, password: FIXTURE_PASSWORD },
  };
}

/** Ouvre une session et signe un jeton, sans passer par le flux de connexion (tests des autres modules). */
export async function issueToken(app: INestApplication, tenantId: string, userId: string, mfa = true): Promise<string> {
  const session = await app.get(TenantDb).runAs(
    tenantId,
    (tx) =>
      tx.session.create({
        data: { tenantId, userId, expiresAt: new Date(Date.now() + SESSION_TTL_MS), mfaVerifiedAt: mfa ? new Date() : null },
        select: { id: true },
      }),
    userId,
  );
  return app.get(AccessTokenService).sign({ tenantId, userId, sessionId: session.id, mfa });
}

/** Plan attribué par défaut aux établissements de test : sans limite d'utilisateurs ni de sites (les autres suites ne testent pas les quotas). */
export const FIXTURE_DEFAULT_PLAN = 'enterprise';

/**
 * Remplace le plan de l'abonnement d'un établissement (statut inchangé), sans facturation ni synchronisation des modules.
 * `trial` conserve le plan d'essai attribué à l'inscription.
 */
export async function setFixturePlan(app: INestApplication, tenantId: string, planCode: string): Promise<void> {
  if (planCode === 'trial') return;
  await app.get(PlatformDb).run(async (tx) => {
    const plan = await tx.plan.findFirstOrThrow({ where: { code: planCode, archivedAt: null }, orderBy: { version: 'desc' } });
    await tx.subscription.update({ where: { tenantId }, data: { planId: plan.id } });
  });
}

/**
 * Établissement complet (tenant, site principal, 13 rôles système, administrateur).
 * `subscriptionPlan` : code du plan attribué (défaut `enterprise`, illimité) ou `trial` pour garder le plan d'essai.
 */
export async function createTenantFixture(
  app: INestApplication,
  options: { optionalModules?: readonly string[]; prefix?: string; subscriptionPlan?: string } = {},
): Promise<TenantFixture> {
  const slug = uniqueSlug(options.prefix ?? 'test');
  const input = signupInput(slug);
  const hash = await app.get(PasswordService).hash(FIXTURE_PASSWORD);
  const provisioned = await app.get(TenantProvisioningService).provision(input, hash, options.optionalModules);
  await setFixturePlan(app, provisioned.tenantId, options.subscriptionPlan ?? FIXTURE_DEFAULT_PLAN);
  const adminToken = await issueToken(app, provisioned.tenantId, provisioned.adminUserId);
  return { ...provisioned, slug, adminEmail: input.admin.email, adminToken };
}

/** Utilisateur actif portant un rôle système donné (ex. 'doctor', 'receptionist'). */
export async function createUserWithRole(
  app: INestApplication,
  tenant: TenantFixture,
  roleCode: string,
  scope: { scopeType: ScopeType; scopeId?: string } = { scopeType: 'tenant' },
  mfa = true,
): Promise<UserFixture> {
  const email = `${roleCode}-${randomBytes(3).toString('hex')}@${tenant.slug}.test`;
  const hash = await app.get(PasswordService).hash(FIXTURE_PASSWORD);
  const userId = await app.get(TenantDb).runAs(tenant.tenantId, async (tx) => {
    const role = await tx.role.findUniqueOrThrow({ where: { tenantId_code: { tenantId: tenant.tenantId, code: roleCode } } });
    const user = await tx.user.create({
      data: {
        tenantId: tenant.tenantId,
        email,
        fullName: `Utilisateur ${roleCode}`,
        status: 'active',
        credential: { create: { passwordHash: hash } },
      },
      select: { id: true },
    });
    await tx.userRoleAssignment.create({
      data: { tenantId: tenant.tenantId, userId: user.id, roleId: role.id, scopeType: scope.scopeType, scopeId: scope.scopeId ?? null },
    });
    return user.id;
  });
  return { userId, email, token: await issueToken(app, tenant.tenantId, userId, mfa) };
}

/** Utilisateur actif portant un rôle personnalisé aux permissions choisies (créé directement en base, sans anti-escalade). */
export async function createUserWithPermissions(
  app: INestApplication,
  tenant: TenantFixture,
  permissions: readonly string[],
  scope: { scopeType: ScopeType; scopeId?: string } = { scopeType: 'tenant' },
  mfa = true,
): Promise<UserFixture> {
  const suffix = randomBytes(3).toString('hex');
  const email = `custom-${suffix}@${tenant.slug}.test`;
  const hash = await app.get(PasswordService).hash(FIXTURE_PASSWORD);
  const userId = await app.get(TenantDb).runAs(tenant.tenantId, async (tx) => {
    const role = await tx.role.create({ data: { tenantId: tenant.tenantId, code: `perm_${suffix}`, name: `Rôle ${suffix}` }, select: { id: true } });
    await tx.rolePermission.createMany({
      data: permissions.map((permissionCode) => ({ tenantId: tenant.tenantId, roleId: role.id, permissionCode })),
    });
    const user = await tx.user.create({
      data: { tenantId: tenant.tenantId, email, fullName: 'Utilisateur personnalisé', status: 'active', credential: { create: { passwordHash: hash } } },
      select: { id: true },
    });
    await tx.userRoleAssignment.create({
      data: { tenantId: tenant.tenantId, userId: user.id, roleId: role.id, scopeType: scope.scopeType, scopeId: scope.scopeId ?? null },
    });
    return user.id;
  });
  return { userId, email, token: await issueToken(app, tenant.tenantId, userId, mfa) };
}
