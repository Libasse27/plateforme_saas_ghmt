import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import type { TenantFixture } from '../helpers/fixtures';

/** Crée un site secondaire directement en base (le module org n'est pas sous test ici). */
export function createSite(app: INestApplication, tenant: TenantFixture, code: string): Promise<string> {
  return app
    .get(TenantDb)
    .runAs(tenant.tenantId, (tx) => tx.site.create({ data: { tenantId: tenant.tenantId, code, name: `Site ${code}` }, select: { id: true } }))
    .then((site) => site.id);
}

export function createPatientRow(
  app: INestApplication,
  tenant: TenantFixture,
  overrides: { birthDate?: Date; deceasedAt?: Date; primarySiteId?: string } = {},
): Promise<string> {
  const suffix = randomBytes(4).toString('hex');
  return app
    .get(TenantDb)
    .runAs(tenant.tenantId, (tx) =>
      tx.patient.create({
        data: { tenantId: tenant.tenantId, ipp: `TEST-${suffix}`, lastName: `Rdv${suffix}`, firstName: 'Patient', searchName: `rdv${suffix} patient`, ...overrides },
        select: { id: true },
      }),
    )
    .then((patient) => patient.id);
}

export function createPractitionerRow(
  app: INestApplication,
  tenant: TenantFixture,
  overrides: { isBookable?: boolean; departmentId?: string } = {},
): Promise<string> {
  return app
    .get(TenantDb)
    .runAs(tenant.tenantId, (tx) =>
      tx.practitioner.create({
        data: { tenantId: tenant.tenantId, fullName: `Dr ${randomBytes(3).toString('hex')}`, isBookable: overrides.isBookable ?? true, departmentId: overrides.departmentId },
        select: { id: true },
      }),
    )
    .then((practitioner) => practitioner.id);
}

export function createDepartmentRow(app: INestApplication, tenant: TenantFixture, siteId: string): Promise<string> {
  return app
    .get(TenantDb)
    .runAs(tenant.tenantId, (tx) =>
      tx.department.create({ data: { tenantId: tenant.tenantId, siteId, code: randomBytes(3).toString('hex'), name: 'Service test' }, select: { id: true } }),
    )
    .then((department) => department.id);
}

/** 1er mars de l'année prochaine, 08:00 UTC : toujours dans le futur (les créneaux passés sont refusés). */
const BASE_TIME = Date.UTC(new Date().getUTCFullYear() + 1, 2, 1, 8);
const MS_PER_MINUTE = 60_000;

/** Créneau [début, fin) en ISO, décalé de `startMinute` minutes après le 1er mars de l'année prochaine 08:00 UTC. */
export function slot(startMinute: number, durationMinutes = 30, dayOffset = 0): { startsAt: string; endsAt: string } {
  const start = BASE_TIME + dayOffset * 24 * 60 * MS_PER_MINUTE + startMinute * MS_PER_MINUTE;
  return { startsAt: new Date(start).toISOString(), endsAt: new Date(start + durationMinutes * MS_PER_MINUTE).toISOString() };
}

/** Ajoute à un utilisateur existant un rôle dédié aux permissions données, limité à une portée précise. */
export async function grantScoped(
  app: INestApplication,
  tenant: TenantFixture,
  userId: string,
  permissions: readonly string[],
  scope: { scopeType: 'tenant' | 'site' | 'department'; scopeId?: string },
): Promise<void> {
  await app.get(TenantDb).runAs(tenant.tenantId, async (tx) => {
    const role = await tx.role.create({ data: { tenantId: tenant.tenantId, code: `scoped-${randomBytes(4).toString('hex')}`, name: 'Rôle à portée' } });
    await tx.rolePermission.createMany({ data: permissions.map((permissionCode) => ({ tenantId: tenant.tenantId, roleId: role.id, permissionCode })) });
    await tx.userRoleAssignment.create({
      data: { tenantId: tenant.tenantId, userId, roleId: role.id, scopeType: scope.scopeType, scopeId: scope.scopeId ?? null },
    });
  });
}
