import { Injectable } from '@nestjs/common';
import type { NotificationChannel, NotificationLocale } from '@ghmt/shared';
import type { NotificationTemplate } from '../../../generated/prisma/client';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';

export interface TemplateKey {
  readonly typeCode: string;
  readonly channel: NotificationChannel;
  readonly locale: NotificationLocale;
}

@Injectable()
export class TemplatesRepository {
  findActive(tx: TenantTx, tenantId: string, key: TemplateKey): Promise<NotificationTemplate | null> {
    return tx.notificationTemplate.findFirst({ where: { tenantId, ...key, isActive: true } });
  }

  listActive(tx: TenantTx, tenantId: string, typeCode?: string): Promise<NotificationTemplate[]> {
    return tx.notificationTemplate.findMany({ where: { tenantId, isActive: true, ...(typeCode ? { typeCode } : {}) } });
  }

  /** Prochaine version de la surcharge : max des versions existantes (actives ou non) + 1. */
  async nextVersion(tx: TenantTx, tenantId: string, key: TemplateKey): Promise<number> {
    const latest = await tx.notificationTemplate.findFirst({ where: { tenantId, ...key }, orderBy: { version: 'desc' }, select: { version: true } });
    return (latest?.version ?? 0) + 1;
  }

  /** Désactive la version active (seule colonne modifiable) puis insère la nouvelle version, immuable. */
  async publish(
    tx: TenantTx,
    tenantId: string,
    key: TemplateKey,
    content: { subject: string | null; body: string; createdBy: string },
  ): Promise<NotificationTemplate> {
    await this.deactivate(tx, tenantId, key);
    const version = await this.nextVersion(tx, tenantId, key);
    return tx.notificationTemplate.create({ data: { tenantId, ...key, version, subject: content.subject, body: content.body, createdBy: content.createdBy, isActive: true } });
  }

  async deactivate(tx: TenantTx, tenantId: string, key: TemplateKey): Promise<number> {
    const { count } = await tx.notificationTemplate.updateMany({ where: { tenantId, ...key, isActive: true }, data: { isActive: false } });
    return count;
  }
}
