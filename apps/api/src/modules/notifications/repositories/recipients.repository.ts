import { Injectable } from '@nestjs/common';
import type { Patient, User } from '../../../generated/prisma/client';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';

export interface UserRecipient {
  readonly id: string;
  readonly locale: string;
}

const OWNER_PERMISSION = 'settings:establishment:update';

@Injectable()
export class RecipientsRepository {
  findPatient(tx: TenantTx, tenantId: string, id: string): Promise<Patient | null> {
    return tx.patient.findUnique({ where: { tenantId_id: { tenantId, id } } });
  }

  findUser(tx: TenantTx, tenantId: string, id: string): Promise<User | null> {
    return tx.user.findUnique({ where: { tenantId_id: { tenantId, id } } });
  }

  /**
   * Destinataires « propriétaire » (docs/10 D14) : utilisateurs actifs ayant `settings:establishment:update` à portée
   * établissement ; à partir de J+7, aussi les titulaires du rôle système `director`.
   */
  async findOwners(tx: TenantTx, tenantId: string, now: Date, includeDirectors: boolean): Promise<UserRecipient[]> {
    const roleFilters = [{ permissions: { some: { permissionCode: OWNER_PERMISSION } } }, ...(includeDirectors ? [{ isSystem: true, templateCode: 'director' }] : [])];
    const users = await tx.user.findMany({
      where: {
        tenantId,
        deletedAt: null,
        status: 'active',
        assignments: {
          some: {
            scopeType: 'tenant',
            revokedAt: null,
            validFrom: { lte: now },
            OR: [{ validUntil: null }, { validUntil: { gt: now } }],
            role: { deletedAt: null, OR: roleFilters },
          },
        },
      },
      select: { id: true, locale: true },
      orderBy: { id: 'asc' },
    });
    return users;
  }

  /** Préférences d'un utilisateur (absente = activée). */
  async isEmailEnabled(tx: TenantTx, tenantId: string, userId: string): Promise<boolean> {
    const preference = await tx.notificationPreference.findUnique({
      where: { tenantId_userId_category_channel: { tenantId, userId, category: 'administrative', channel: 'email' } },
      select: { enabled: true },
    });
    return preference?.enabled ?? true;
  }

  async siteIdsOfDepartments(tx: TenantTx, tenantId: string, departmentIds: readonly string[]): Promise<string[]> {
    if (departmentIds.length === 0) return [];
    const departments = await tx.department.findMany({ where: { tenantId, id: { in: [...departmentIds] } }, select: { siteId: true } });
    return departments.map((department) => department.siteId);
  }

  async departmentNames(tx: TenantTx, tenantId: string): Promise<string[]> {
    const departments = await tx.department.findMany({ where: { tenantId, deletedAt: null }, select: { name: true } });
    return departments.map((department) => department.name);
  }
}
