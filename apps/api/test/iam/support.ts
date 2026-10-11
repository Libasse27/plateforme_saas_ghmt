import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { generate, generateSecret } from 'otplib';
import { FieldCrypto } from '../../src/common/crypto/field-crypto.service';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { issueToken, type TenantFixture } from '../helpers/fixtures';
import { acceptInvitationFor } from '../helpers/invitations';

export const bearer = (token: string): { Authorization: string } => ({ Authorization: `Bearer ${token}` });

export interface ScopeInput {
  readonly scopeType: 'tenant' | 'site' | 'department';
  readonly scopeId?: string;
}

/** Crée un site via l'API (administrateur) et renvoie son identifiant. */
export async function createSite(app: INestApplication, tenant: TenantFixture, code: string): Promise<string> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/org/sites')
    .set(bearer(tenant.adminToken))
    .send({ code, name: `Site ${code}` })
    .expect(201);
  return res.body.data.id as string;
}

/** Crée un rôle personnalisé via l'API administrateur et renvoie son identifiant. */
export async function createCustomRole(
  app: INestApplication,
  tenant: TenantFixture,
  permissions: readonly string[],
  code = `custom_${randomBytes(3).toString('hex')}`,
): Promise<{ id: string; code: string }> {
  const res = await request(app.getHttpServer())
    .post('/api/v1/iam/roles')
    .set(bearer(tenant.adminToken))
    .send({ code, name: `Rôle ${code}`, permissions })
    .expect(201);
  return { id: res.body.data.id as string, code };
}

/** Utilisateur portant un rôle personnalisé aux permissions choisies (créé via l'API administrateur). */
export async function createUserWithCustomPermissions(
  app: INestApplication,
  tenant: TenantFixture,
  permissions: readonly string[],
  scope: ScopeInput = { scopeType: 'tenant' },
): Promise<{ userId: string; token: string; roleId: string }> {
  const role = await createCustomRole(app, tenant, permissions);
  const email = `delegue-${randomBytes(3).toString('hex')}@${tenant.slug}.test`;
  const res = await request(app.getHttpServer())
    .post('/api/v1/iam/users')
    .set(bearer(tenant.adminToken))
    .send({ fullName: 'Délégué Test', email, roleAssignments: [{ roleId: role.id, ...scope }] })
    .expect(201);
  const userId = res.body.data.id as string;
  // Compte invité : il devient actif en acceptant l'invitation reçue par e-mail (flux réel).
  await acceptInvitationFor(app, email);
  return { userId, roleId: role.id, token: await issueToken(app, tenant.tenantId, userId) };
}

export async function roleIdByCode(app: INestApplication, tenant: TenantFixture, code: string): Promise<string> {
  return app.get(TenantDb).runAs(tenant.tenantId, async (tx) => {
    const role = await tx.role.findFirstOrThrow({ where: { code }, select: { id: true } });
    return role.id;
  });
}

/** Événements d'audit d'une action donnée (lecture directe, pour vérifier la trace). */
export async function auditEntries(app: INestApplication, tenantId: string, action: string) {
  return app.get(TenantDb).runAs(tenantId, (tx) => tx.auditLog.findMany({ where: { action }, orderBy: { chainSeq: 'asc' } }));
}

/** Active directement un TOTP pour un utilisateur (sans passer par l'enrôlement) ; renvoie le secret. */
export async function activateTotp(app: INestApplication, tenantId: string, userId: string): Promise<string> {
  const secret = generateSecret();
  const secretEnc = app.get(FieldCrypto).encrypt(tenantId, secret);
  await app.get(TenantDb).runAs(tenantId, (tx) =>
    tx.mfaFactor.upsert({
      where: { tenantId_userId_kind: { tenantId, userId, kind: 'totp' } },
      create: { tenantId, userId, kind: 'totp', secretEnc, activatedAt: new Date() },
      update: { secretEnc, activatedAt: new Date(), lastUsedStep: null },
    }),
  );
  return secret;
}

/**
 * Code TOTP utilisable pour une opération de pouvoir : l'anti-rejeu refuse un pas déjà consommé, on l'efface donc avant
 * chaque appel (plusieurs opérations dans la même fenêtre de 30 s).
 */
export async function stepUpCode(app: INestApplication, tenantId: string, userId: string, secret: string): Promise<string> {
  await app.get(TenantDb).runAs(tenantId, (tx) => tx.mfaFactor.updateMany({ where: { userId, kind: 'totp' }, data: { lastUsedStep: null } }));
  return generate({ secret });
}

/** Code TOTP faux mais bien formé : aucun des codes acceptés dans la fenêtre de tolérance (±1 pas). */
export async function wrongTotpCode(secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const accepted = await Promise.all([-30, 0, 30].map((offset) => generate({ secret, epoch: now + offset })));
  return ['000000', '111111', '222222', '333333'].find((code) => !accepted.includes(code))!;
}
