import { Inject, Injectable } from '@nestjs/common';
import type { NotificationSettingsView, UpdateNotificationSettingsInput } from '@ghmt/shared';
import { AuditService } from '../../../common/audit/audit.service';
import { EntitlementService } from '../../../common/authz/entitlement.service';
import { RequestContext } from '../../../common/context/request-context';
import { DomainError } from '../../../common/errors/domain-error';
import { Clock } from '../../../common/time/clock';
import { ENV, type Env } from '../../../infrastructure/config/env';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { findForbiddenTerms } from '../domain/privacy-terms';
import { isLocalTimeInQuietHours } from '../domain/quiet-hours';
import type { EffectiveSettings } from '../mappers/settings.mapper';
import { SettingsRepository } from '../repositories/settings.repository';
import { SmsQuotaService } from './sms-quota.service';

/** Paramètres de notification de l'établissement (docs/10 §5.3) : plages silencieuses, translittération, rappels, expéditeur. */
@Injectable()
export class SettingsService {
  constructor(
    private readonly db: TenantDb,
    private readonly repo: SettingsRepository,
    private readonly quota: SmsQuotaService,
    private readonly entitlements: EntitlementService,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  get(): Promise<NotificationSettingsView> {
    const { tenantId } = this.context.requirePrincipal();
    return this.db.run(async (tx) => this.view(tx, tenantId, await this.repo.load(tx, tenantId)));
  }

  update(input: UpdateNotificationSettingsInput): Promise<NotificationSettingsView> {
    const { tenantId, userId } = this.context.requirePrincipal();
    const changes = Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
    return this.db.run(async (tx) => {
      const merged = { ...(await this.repo.load(tx, tenantId)), ...changes };
      if (merged.quietHoursStart === merged.quietHoursEnd) {
        throw DomainError.unprocessable('invalid_quiet_hours', 'Le début et la fin de la plage silencieuse doivent différer.');
      }
      if (isLocalTimeInQuietHours(merged.reminderD1LocalTime, { start: merged.quietHoursStart, end: merged.quietHoursEnd })) {
        throw DomainError.unprocessable('invalid_reminder_time', 'L’heure du rappel J-1 ne peut pas tomber dans la plage silencieuse.');
      }
      if (typeof merged.senderDisplayName === 'string' && findForbiddenTerms(merged.senderDisplayName).length > 0) {
        throw DomainError.validation([{ path: 'senderDisplayName', code: 'forbidden_term', message: 'Ce nom contient un terme interdit (confidentialité).' }]);
      }
      await this.repo.save(tx, tenantId, input, userId);
      await this.audit.record(tx, tenantId, { action: 'notification.settings_updated', resourceType: 'notification_settings', resourceId: tenantId, changes });
      return this.view(tx, tenantId, await this.repo.load(tx, tenantId));
    });
  }

  private async view(tx: TenantTx, tenantId: string, settings: EffectiveSettings): Promise<NotificationSettingsView> {
    const now = this.clock.now();
    const entitlements = await this.entitlements.getInTx(tx);
    return {
      quietHoursStart: settings.quietHoursStart,
      quietHoursEnd: settings.quietHoursEnd,
      smsTransliterate: settings.smsTransliterate,
      senderDisplayName: settings.senderDisplayName,
      appointmentSmsEnabled: settings.appointmentSmsEnabled,
      reminderD1Enabled: settings.reminderD1Enabled,
      reminderD1LocalTime: settings.reminderD1LocalTime,
      reminderH2Enabled: settings.reminderH2Enabled,
      smsProvider: this.env.SMS_PROVIDER,
      smsUsage: {
        month: now.toISOString().slice(0, 7),
        usedSegments: await this.quota.usedSegments(tx, tenantId, null, now),
        limit: entitlements?.entitlements.limits.smsMonthly ?? null,
      },
      updatedAt: settings.updatedAt?.toISOString() ?? null,
    };
  }
}
