import { Injectable } from '@nestjs/common';
import { EntitlementService } from '../../../common/authz/entitlement.service';
import { utcMonthBounds } from '../../../common/authz/entitlement-rules';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { QUOTA_THRESHOLDS } from '../notifications.constants';
import { QuotaAlertService } from './quota-alert.service';

export interface QuotaDecision {
  readonly allowed: boolean;
}

const monthKey = (instant: Date): string => instant.toISOString().slice(0, 7);

/**
 * Quota SMS du plan (docs/10 D13) : `limits.smsMonthly` compté en SEGMENTS `sent|delivered` du mois UTC, plus les envois
 * en cours, sous verrou d'avis par établissement. `null` (ou aucun abonnement) = illimité. Les alertes à 80 % et 100 %
 * sont émises une seule fois par mois et par seuil.
 */
@Injectable()
export class SmsQuotaService {
  constructor(
    private readonly entitlements: EntitlementService,
    private readonly alerts: QuotaAlertService,
  ) {}

  async reserve(tx: TenantTx, tenantId: string, notificationId: string, segments: number, now: Date): Promise<QuotaDecision> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('sms-quota:' || ${tenantId}, 0))`;
    const limit = (await this.entitlements.getInTx(tx))?.entitlements.limits.smsMonthly ?? null;
    if (limit === null) return { allowed: true };
    const used = await this.usedSegments(tx, tenantId, notificationId, now);
    const allowed = used + segments <= limit;
    const consumed = allowed ? used + segments : limit;
    const thresholds = QUOTA_THRESHOLDS.filter((percent) => consumed * 100 >= percent * limit);
    await this.alerts.ensure(tx, tenantId, { month: monthKey(now), thresholds, limit }, now);
    return { allowed };
  }

  /** Segments consommés ce mois (UTC) : SMS `sent|delivered` du mois + SMS en cours d'envoi (réservés et sous bail). */
  async usedSegments(tx: TenantTx, tenantId: string, excludingId: string | null, now: Date): Promise<number> {
    const { start, end } = utcMonthBounds(now);
    const rows = await tx.$queryRaw<{ used: number }[]>`
      SELECT COALESCE(SUM(segments), 0)::int AS used FROM tenant.notifications
      WHERE tenant_id = ${tenantId}::uuid AND channel = 'sms' AND segments IS NOT NULL
        AND (${excludingId}::uuid IS NULL OR id <> ${excludingId}::uuid)
        AND ((status IN ('sent', 'delivered') AND sent_at >= ${start}::timestamptz AND sent_at < ${end}::timestamptz)
          OR (status = 'queued' AND locked_until > ${now}::timestamptz))`;
    return rows[0]?.used ?? 0;
  }
}
