import { Injectable } from '@nestjs/common';
import type { NotificationCategory, NotificationChannel, NotificationLocale, SuppressionReason } from '@ghmt/shared';
import { Prisma, type Notification } from '../../../generated/prisma/client';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { uuidv7 } from '../domain/uuid-v7';

export interface NewNotification {
  readonly typeCode: string;
  readonly category: NotificationCategory;
  readonly channel: NotificationChannel;
  readonly recipientType: 'user' | 'patient';
  readonly recipientId: string;
  readonly subjectType: string | null;
  readonly subjectId: string | null;
  readonly subjectVersion: string | null;
  readonly sourceEventId: string | null;
  readonly dedupKey: string;
  readonly locale: NotificationLocale;
  readonly context: Readonly<Record<string, unknown>>;
  readonly suppressionReason: SuppressionReason | null;
  readonly scheduledAt: Date;
  readonly deadlineAt: Date | null;
}

export type ConflictMode = 'skip' | 'reactivate_stale' | 'reactivate_no_consent';

/**
 * Réactivation d'une ligne supprimée `stale` (retour à l'horaire initial d'un rendez-vous, docs/10 D8) : seule cette
 * combinaison précise est rejouée ; toute autre ligne existante est laissée telle quelle.
 */
const REACTIVATE_STALE = Prisma.sql`
  ON CONFLICT (tenant_id, dedup_key) DO UPDATE SET
    status = 'queued', suppression_reason = NULL, suppressed_at = NULL,
    scheduled_at = EXCLUDED.scheduled_at, next_attempt_at = EXCLUDED.next_attempt_at, deadline_at = EXCLUDED.deadline_at,
    attempts = 0, locked_until = NULL, error_class = NULL, error_code = NULL, updated_at = now()
  WHERE tenant.notifications.status = 'suppressed' AND tenant.notifications.suppression_reason = 'stale' AND EXCLUDED.status = 'queued'`;
/** Octroi d'un consentement : une ligne supprimée faute de consentement redevient attendue (même clé de déduplication). */
const REACTIVATE_NO_CONSENT = Prisma.sql`
  ON CONFLICT (tenant_id, dedup_key) DO UPDATE SET
    status = 'queued', suppression_reason = NULL, suppressed_at = NULL,
    scheduled_at = EXCLUDED.scheduled_at, next_attempt_at = EXCLUDED.next_attempt_at, deadline_at = EXCLUDED.deadline_at,
    attempts = 0, locked_until = NULL, error_class = NULL, error_code = NULL, updated_at = now()
  WHERE tenant.notifications.status = 'suppressed' AND tenant.notifications.suppression_reason = 'no_consent' AND EXCLUDED.status = 'queued'`;
const CONFLICT_CLAUSES: Readonly<Record<'skip' | 'reactivate_stale' | 'reactivate_no_consent', Prisma.Sql>> = {
  skip: Prisma.sql`ON CONFLICT (tenant_id, dedup_key) DO NOTHING`,
  reactivate_stale: REACTIVATE_STALE,
  reactivate_no_consent: REACTIVATE_NO_CONSENT,
};

@Injectable()
export class NotificationsRepository {
  /** Insère une ligne ; `dedup_key` unique ⇒ un rejeu est sans effet. Retourne le nombre de lignes écrites (0 ou 1). */
  async insert(tx: TenantTx, tenantId: string, row: NewNotification, now: Date, mode: ConflictMode = 'skip'): Promise<number> {
    const suppressed = row.suppressionReason !== null;
    return tx.$executeRaw`
      INSERT INTO tenant.notifications (
        id, tenant_id, type_code, category, channel, recipient_type, recipient_id, subject_type, subject_id, subject_version,
        source_event_id, dedup_key, locale, context, status, suppression_reason, scheduled_at, next_attempt_at, deadline_at,
        suppressed_at, created_at, updated_at)
      VALUES (
        ${uuidv7()}::uuid, ${tenantId}::uuid, ${row.typeCode}, ${row.category}, ${row.channel}, ${row.recipientType},
        ${row.recipientId}::uuid, ${row.subjectType}, ${row.subjectId}::uuid, ${row.subjectVersion},
        ${row.sourceEventId}::uuid, ${row.dedupKey}, ${row.locale}, ${JSON.stringify(row.context)}::jsonb,
        ${suppressed ? 'suppressed' : 'queued'}, ${row.suppressionReason}, ${row.scheduledAt}::timestamptz,
        ${row.scheduledAt}::timestamptz, ${row.deadlineAt}::timestamptz, ${suppressed ? now : null}::timestamptz,
        ${now}::timestamptz, ${now}::timestamptz)
      ${CONFLICT_CLAUSES[mode]}`;
  }

  /** Réserve des notifications dues (`FOR UPDATE SKIP LOCKED`) en posant un bail ; sûr avec plusieurs instances. */
  async reserveDue(tx: TenantTx, tenantId: string, now: Date, limit: number, leaseUntil: Date): Promise<Notification[]> {
    const reserved = await tx.$queryRaw<{ id: string }[]>`
      UPDATE tenant.notifications SET locked_until = ${leaseUntil}::timestamptz, updated_at = ${now}::timestamptz
      WHERE tenant_id = ${tenantId}::uuid AND id IN (
        SELECT id FROM tenant.notifications
        WHERE tenant_id = ${tenantId}::uuid AND status = 'queued' AND next_attempt_at <= ${now}::timestamptz
          AND (locked_until IS NULL OR locked_until < ${now}::timestamptz)
        ORDER BY next_attempt_at, id LIMIT ${limit} FOR UPDATE SKIP LOCKED)
      RETURNING id::text AS id`;
    if (reserved.length === 0) return [];
    return tx.notification.findMany({ where: { tenantId, id: { in: reserved.map((r) => r.id) } }, orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }] });
  }

  /** Renouvelle le bail seulement s'il est toujours celui posé à la réservation (0 ligne ⇒ un autre processus a repris la ligne). */
  async renewLease(tx: TenantTx, row: Pick<Notification, 'tenantId' | 'id' | 'lockedUntil'>, until: Date): Promise<boolean> {
    if (row.lockedUntil === null) return false;
    const { count } = await tx.notification.updateMany({
      where: { tenantId: row.tenantId, id: row.id, status: 'queued', lockedUntil: row.lockedUntil },
      data: { lockedUntil: until },
    });
    return count > 0;
  }

  findById(tx: TenantTx, tenantId: string, id: string): Promise<Notification | null> {
    return tx.notification.findUnique({ where: { tenantId_id: { tenantId, id } } });
  }

  /** Rappels en attente d'un rendez-vous dont la version (horaire) diffère de `keepVersion` : `stale`. */
  suppressRemindersOtherThan(tx: TenantTx, tenantId: string, appointmentId: string, keepVersion: string, now: Date): Promise<number> {
    return this.suppressWhere(tx, { tenantId, subjectType: 'appointment', subjectId: appointmentId, category: 'clinical_reminder', subjectVersion: { not: keepVersion } }, 'stale', now);
  }

  /** Rappels en attente d'un rendez-vous annulé ou supprimé. */
  suppressReminders(tx: TenantTx, tenantId: string, appointmentId: string, now: Date): Promise<number> {
    return this.suppressWhere(tx, { tenantId, subjectType: 'appointment', subjectId: appointmentId, category: 'clinical_reminder' }, 'appointment_cancelled', now);
  }

  /** Rappels en attente d'un patient sur un canal (révocation du consentement ou STOP). */
  suppressPatientReminders(tx: TenantTx, tenantId: string, patientId: string, channel: NotificationChannel, now: Date): Promise<number> {
    return this.suppressWhere(tx, { tenantId, recipientType: 'patient', recipientId: patientId, category: 'clinical_reminder', channel }, 'no_consent', now);
  }

  /** Relances d'une facture SaaS réglée. */
  suppressInvoiceReminders(tx: TenantTx, tenantId: string, invoiceId: string, now: Date): Promise<number> {
    return this.suppressWhere(tx, { tenantId, subjectType: 'saas_invoice', subjectId: invoiceId }, 'invoice_settled', now);
  }

  /**
   * Un même rappel ne part que sur un canal : quand le SMS est (ré)activé, l'e-mail en attente du même rappel
   * (même rendez-vous, type et version) est supprimé.
   */
  async suppressDuplicateChannelReminders(tx: TenantTx, tenantId: string, patientId: string, now: Date): Promise<number> {
    return tx.$executeRaw`
      UPDATE tenant.notifications e SET status = 'suppressed', suppression_reason = 'stale', suppressed_at = ${now}::timestamptz,
        locked_until = NULL, updated_at = ${now}::timestamptz
      WHERE e.tenant_id = ${tenantId}::uuid AND e.recipient_id = ${patientId}::uuid AND e.category = 'clinical_reminder'
        AND e.channel = 'email' AND e.status = 'queued'
        AND EXISTS (
          SELECT 1 FROM tenant.notifications s
          WHERE s.tenant_id = e.tenant_id AND s.recipient_id = e.recipient_id AND s.type_code = e.type_code
            AND s.subject_id = e.subject_id AND s.subject_version = e.subject_version AND s.channel = 'sms' AND s.status = 'queued')`;
  }

  private async suppressWhere(tx: TenantTx, where: Prisma.NotificationWhereInput, reason: SuppressionReason, now: Date): Promise<number> {
    const { count } = await tx.notification.updateMany({
      where: { ...where, status: 'queued' },
      data: { status: 'suppressed', suppressionReason: reason, suppressedAt: now, lockedUntil: null, updatedAt: now },
    });
    return count;
  }
}
