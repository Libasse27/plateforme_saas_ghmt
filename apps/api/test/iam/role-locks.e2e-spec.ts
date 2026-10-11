import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantDb, type TenantTx } from '../../src/infrastructure/prisma/tenant-db.service';
import { bearer, http } from '../auth/auth-helpers';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { createCustomRole } from './support';

const ADMIN_WRITE = 'iam:user:update';
const PLAIN = 'patients:patient:read';
/** Laisse à la requête concurrente le temps d'atteindre le verrou (sans verrou, elle aurait déjà répondu). */
const RACE_WINDOW_MS = 400;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Course rôle / affectation (H3, docs/11 §14.1) : la modification des droits d'un rôle et la création d'une affectation de ce
 * rôle sont sérialisées par le verrou de la ligne du rôle ; aucune des deux ne décide sur un état périmé.
 */
describe('iam : verrou du rôle entre modification et affectation', () => {
  let app: INestApplication;
  let tenant: TenantFixture;
  let admin2: UserFixture;

  /** Exécute `concurrent` pendant qu'une transaction tierce tient un verrou (`lock`) et applique `change`. */
  async function whileLocked<T>(lock: (tx: TenantTx) => Promise<unknown>, change: (tx: TenantTx) => Promise<unknown>, concurrent: () => Promise<T>): Promise<T> {
    let pending: Promise<T> | undefined;
    await app.get(TenantDb).runAs(tenant.tenantId, async (tx) => {
      await lock(tx);
      await change(tx);
      pending = concurrent();
      await pause(RACE_WINDOW_MS);
    });
    return pending!;
  }

  const whileRoleLocked = <T>(roleId: string, mode: 'UPDATE' | 'SHARE', change: (tx: TenantTx) => Promise<unknown>, concurrent: () => Promise<T>): Promise<T> =>
    whileLocked(
      (tx) => (mode === 'UPDATE' ? tx.$queryRaw`SELECT id FROM tenant.roles WHERE id = ${roleId}::uuid FOR UPDATE` : tx.$queryRaw`SELECT id FROM tenant.roles WHERE id = ${roleId}::uuid FOR SHARE`),
      change,
      concurrent,
    );

  /** Transfert du titre de principal en cours vers `userId` (transaction tierce, verrou sur `security_settings`). */
  const duringTransferTo = <T>(userId: string, concurrent: () => Promise<T>): Promise<T> =>
    whileLocked(
      (tx) => tx.$queryRaw`SELECT tenant_id FROM tenant.security_settings WHERE tenant_id = ${tenant.tenantId}::uuid FOR UPDATE`,
      (tx) => tx.securitySettings.update({ where: { tenantId: tenant.tenantId }, data: { ownerUserId: userId } }),
      concurrent,
    );
  const restoreOwner = () => app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.securitySettings.update({ where: { tenantId: tenant.tenantId }, data: { ownerUserId: tenant.adminUserId } }));

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await createTenantFixture(app, { prefix: 'role-lock' });
    admin2 = await createUserWithRole(app, tenant, 'tenant_admin');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('une affectation attend la modification en cours du rôle et voit ses nouveaux droits (403 owner_required)', async () => {
    const role = await createCustomRole(app, tenant, [PLAIN]);
    const target = await createUserWithRole(app, tenant, 'cashier');

    const res = await whileRoleLocked(
      role.id,
      'UPDATE',
      (tx) => tx.rolePermission.create({ data: { tenantId: tenant.tenantId, roleId: role.id, permissionCode: ADMIN_WRITE } }),
      async () => http(app).post(`/api/v1/iam/users/${target.userId}/assignments`).set(bearer(admin2.token)).send({ roleId: role.id, scopeType: 'tenant' }),
    );

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('owner_required');
  });

  it('une modification du rôle attend l’affectation en cours et voit son titulaire (403 owner_required)', async () => {
    const role = await createCustomRole(app, tenant, [PLAIN]);
    const holder = await createUserWithRole(app, tenant, 'cashier');

    const res = await whileRoleLocked(
      role.id,
      'SHARE',
      (tx) => tx.userRoleAssignment.create({ data: { tenantId: tenant.tenantId, userId: holder.userId, roleId: role.id, scopeType: 'tenant' } }),
      async () => http(app).patch(`/api/v1/iam/roles/${role.id}`).set(bearer(admin2.token)).send({ permissions: [PLAIN, ADMIN_WRITE] }),
    );

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('owner_required');
  });

  describe('transfert du titre de principal en cours', () => {
    it('la désactivation du nouveau principal attend le transfert et le voit (403 admin_hierarchy)', async () => {
      const heir = await createUserWithRole(app, tenant, 'tenant_admin');

      const res = await duringTransferTo(heir.userId, async () => http(app).post(`/api/v1/iam/users/${heir.userId}/disable`).set(bearer(tenant.adminToken)));

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('admin_hierarchy');
      await restoreOwner();
    });

    it('le retrait du rôle administrateur du nouveau principal attend le transfert et le voit (409 owner_must_transfer)', async () => {
      const heir = await createUserWithRole(app, tenant, 'tenant_admin');
      const assignment = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.userRoleAssignment.findFirstOrThrow({ where: { userId: heir.userId }, select: { id: true } }));

      const res = await duringTransferTo(heir.userId, async () => http(app).delete(`/api/v1/iam/users/${heir.userId}/assignments/${assignment.id}`).set(bearer(tenant.adminToken)));

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('owner_must_transfer');
      await restoreOwner();
    });
  });
});
