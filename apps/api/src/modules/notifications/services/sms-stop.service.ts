import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../../common/audit/audit.service';
import { FieldCrypto } from '../../../common/crypto/field-crypto.service';
import { TenantDb } from '../../../infrastructure/prisma/tenant-db.service';
import { ConsentsRepository } from '../repositories/consents.repository';
import { NotificationsRepository } from '../repositories/notifications.repository';
import { RecipientHasher } from './recipient-hasher';
import { SmsRecipientRegistry } from './sms-recipient-registry';

/**
 * STOP entrant (docs/10 D10, §5.7) : le numéro est cherché dans `platform.sms_recipient_tenants` (établissements ayant écrit
 * à ce numéro depuis 180 jours) ; dans CHACUN d'eux, les patients portant ce numéro (index aveugle) voient leur consentement
 * SMS révoqué (`sms_stop`, audit acteur `system`) et leurs rappels SMS en attente supprimés.
 */
@Injectable()
export class SmsStopService {
  private readonly logger = new Logger(SmsStopService.name);

  constructor(
    private readonly db: TenantDb,
    private readonly registry: SmsRecipientRegistry,
    private readonly hasher: RecipientHasher,
    private readonly crypto: FieldCrypto,
    private readonly consents: ConsentsRepository,
    private readonly notifications: NotificationsRepository,
    private readonly audit: AuditService,
  ) {}

  /** Retourne le nombre d'établissements traités avec succès. */
  async revokeEverywhere(phone: string, now: Date): Promise<number> {
    const tenantIds = await this.registry.tenantsFor(this.hasher.hash(phone), now);
    let handled = 0;
    for (const tenantId of tenantIds) {
      try {
        await this.revokeInTenant(tenantId, phone, now);
        handled += 1;
      } catch (error: unknown) {
        this.logger.error({ tenantId, errorCode: error instanceof Error ? error.name : 'unknown' }, 'Révocation STOP impossible pour un établissement');
      }
    }
    return handled;
  }

  private revokeInTenant(tenantId: string, phone: string, now: Date): Promise<void> {
    return this.db.runAs(tenantId, async (tx) => {
      const patients = await tx.patient.findMany({ where: { tenantId, phoneBidx: this.crypto.blindIndex(tenantId, phone), deletedAt: null }, select: { id: true } });
      for (const { id: patientId } of patients) {
        await this.consents.record(tx, tenantId, { patientId, channel: 'sms', granted: false, source: 'sms_stop', recordedBy: null });
        await this.audit.record(tx, tenantId, {
          action: 'patient.consent_changed',
          actorType: 'system',
          resourceType: 'patient',
          resourceId: patientId,
          patientId,
          changes: { channel: 'sms', purpose: 'appointment_reminder', granted: false, source: 'sms_stop' },
        });
        await this.notifications.suppressPatientReminders(tx, tenantId, patientId, 'sms', now);
      }
    });
  }
}
