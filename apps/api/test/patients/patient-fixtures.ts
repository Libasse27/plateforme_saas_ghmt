import type { INestApplication } from '@nestjs/common';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';

/** Utilisateur « réceptionniste » auquel on ajoute des permissions précises (ex. suppression de patient). */
export async function createReceptionistWith(
  app: INestApplication,
  tenant: TenantFixture,
  extraPermissions: readonly string[],
): Promise<UserFixture> {
  const user = await createUserWithRole(app, tenant, 'receptionist');
  await app.get(TenantDb).runAs(tenant.tenantId, async (tx) => {
    const assignment = await tx.userRoleAssignment.findFirstOrThrow({ where: { userId: user.userId }, select: { roleId: true } });
    // Rôle dédié : on ne modifie pas le rôle système cloné.
    const role = await tx.role.create({ data: { tenantId: tenant.tenantId, code: `custom-${user.userId.slice(0, 8)}`, name: 'Rôle de test' } });
    await tx.rolePermission.createMany({
      data: extraPermissions.map((permissionCode) => ({ tenantId: tenant.tenantId, roleId: role.id, permissionCode })),
    });
    await tx.userRoleAssignment.create({
      data: { tenantId: tenant.tenantId, userId: user.userId, roleId: role.id, scopeType: 'tenant', scopeId: null },
    });
    return assignment.roleId;
  });
  return user;
}
