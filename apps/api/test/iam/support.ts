import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
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
