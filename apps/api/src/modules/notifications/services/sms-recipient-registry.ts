import { Injectable } from '@nestjs/common';
import { PlatformDb } from '../../../infrastructure/prisma/platform-db.service';
import { STOP_ROUTING_WINDOW_MS } from '../notifications.constants';

const toBytes = (buffer: Buffer): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(new ArrayBuffer(buffer.length));
  out.set(buffer);
  return out;
};

/**
 * `platform.sms_recipient_tenants` (PlatformDb uniquement) : quels établissements ont écrit à quel numéro (HMAC) ces
 * 180 derniers jours, pour router un STOP entrant vers chacun d'eux. Jamais le numéro en clair.
 */
@Injectable()
export class SmsRecipientRegistry {
  constructor(private readonly platformDb: PlatformDb) {}

  async touch(phoneHmac: Buffer, tenantId: string, sentAt: Date): Promise<void> {
    const key = toBytes(phoneHmac);
    await this.platformDb.run((tx) =>
      tx.smsRecipientTenant.upsert({
        where: { phoneHmac_tenantId: { phoneHmac: key, tenantId } },
        create: { phoneHmac: key, tenantId, lastSentAt: sentAt },
        update: { lastSentAt: sentAt },
      }),
    );
  }

  async tenantsFor(phoneHmac: Buffer, now: Date): Promise<string[]> {
    const rows = await this.platformDb.run((tx) =>
      tx.smsRecipientTenant.findMany({
        where: { phoneHmac: toBytes(phoneHmac), lastSentAt: { gte: new Date(now.getTime() - STOP_ROUTING_WINDOW_MS) } },
        select: { tenantId: true },
        orderBy: { tenantId: 'asc' },
      }),
    );
    return rows.map((row) => row.tenantId);
  }

  async purgeOlderThan(before: Date): Promise<number> {
    const { count } = await this.platformDb.run((tx) => tx.smsRecipientTenant.deleteMany({ where: { lastSentAt: { lt: before } } }));
    return count;
  }
}
