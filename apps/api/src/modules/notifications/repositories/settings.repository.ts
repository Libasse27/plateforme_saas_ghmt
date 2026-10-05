import { Injectable } from '@nestjs/common';
import type { UpdateNotificationSettingsInput } from '@ghmt/shared';
import type { NotificationSettings } from '../../../generated/prisma/client';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { DEFAULT_SETTINGS, hhmmToTime, toEffectiveSettings, type EffectiveSettings } from '../mappers/settings.mapper';

@Injectable()
export class SettingsRepository {
  async load(tx: TenantTx, tenantId: string): Promise<EffectiveSettings> {
    return toEffectiveSettings(await tx.notificationSettings.findUnique({ where: { tenantId } }));
  }

  /** Fusionne le changement avec les réglages effectifs et écrit la ligne unique du tenant (upsert). */
  async save(tx: TenantTx, tenantId: string, change: UpdateNotificationSettingsInput, updatedBy: string): Promise<NotificationSettings> {
    const merged = { ...(await this.load(tx, tenantId)), ...stripUndefined(change) };
    const data = {
      quietHoursStart: hhmmToTime(merged.quietHoursStart),
      quietHoursEnd: hhmmToTime(merged.quietHoursEnd),
      smsTransliterate: merged.smsTransliterate,
      senderDisplayName: merged.senderDisplayName,
      appointmentSmsEnabled: merged.appointmentSmsEnabled,
      reminderD1Enabled: merged.reminderD1Enabled,
      reminderD1LocalTime: hhmmToTime(merged.reminderD1LocalTime),
      reminderH2Enabled: merged.reminderH2Enabled,
      updatedBy,
      updatedAt: new Date(),
    };
    return tx.notificationSettings.upsert({ where: { tenantId }, create: { tenantId, ...data }, update: data });
  }

  defaults(): EffectiveSettings {
    return DEFAULT_SETTINGS;
  }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as Partial<T>;
}
