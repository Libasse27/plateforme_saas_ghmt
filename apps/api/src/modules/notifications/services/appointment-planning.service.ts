import { Injectable } from '@nestjs/common';
import type { Appointment, NotificationOutboxEvent, Patient } from '../../../generated/prisma/client';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { loadTenantProfile } from '../../../infrastructure/tenancy/tenant-profile';
import { planAppointmentNotifications, type AppointmentEventType, type ContactFacts, type PlannedNotification } from '../domain/appointment-plan';
import { dedupKey } from '../domain/dedup-key';
import { ConsentsRepository } from '../repositories/consents.repository';
import { NotificationsRepository, type ConflictMode, type NewNotification } from '../repositories/notifications.repository';
import { RecipientsRepository } from '../repositories/recipients.repository';
import { SettingsRepository } from '../repositories/settings.repository';
import type { EffectiveSettings } from '../mappers/settings.mapper';
import { outboxPayloadSchema } from '../../../common/notifications/outbox';

const REMINDER_TYPES: ReadonlySet<string> = new Set(['appointment.reminder_d1', 'appointment.reminder_h2']);
const ACTIVE_STATUSES: ReadonlySet<string> = new Set(['scheduled', 'confirmed']);

interface PlanningState {
  readonly appointment: Appointment;
  readonly patient: Patient;
  readonly timeZone: string;
  readonly settings: EffectiveSettings;
  readonly contact: ContactFacts;
}

/**
 * Planification des notifications d'un rendez-vous (docs/10 §5.9) à partir d'un événement d'outbox ou du balayeur. Idempotent :
 * chaque ligne porte une clé de déduplication, un rejeu ne crée aucun doublon. Aucune donnée de santé n'est écrite.
 */
@Injectable()
export class AppointmentPlanningService {
  constructor(
    private readonly notifications: NotificationsRepository,
    private readonly recipients: RecipientsRepository,
    private readonly settingsRepo: SettingsRepository,
    private readonly consents: ConsentsRepository,
  ) {}

  /** Traite un événement d'outbox : annulations de rappels, puis création des lignes attendues. */
  async handleEvent(tx: TenantTx, tenantId: string, event: NotificationOutboxEvent, now: Date): Promise<void> {
    const payload = outboxPayloadSchema.parse(event.payload);
    const state = await this.loadState(tx, tenantId, event.aggregateId);
    if (!state) return;
    const eventType = event.eventType as AppointmentEventType;
    const startsAt = new Date(payload.startsAt);
    // Les rappels ne concernent que l'horaire COURANT d'un rendez-vous encore actif ; un événement dépassé ne touche pas aux rappels.
    const current = ACTIVE_STATUSES.has(state.appointment.status) && state.appointment.deletedAt === null && state.appointment.startsAt.getTime() === startsAt.getTime();
    await this.cancelPendingReminders(tx, tenantId, eventType, state, startsAt, current, now);
    const planned = planAppointmentNotifications({
      eventType,
      eventId: event.id,
      appointmentId: state.appointment.id,
      startsAt,
      takenAt: event.createdAt,
      timeZone: state.timeZone,
      settings: state.settings,
      contact: state.contact,
      deceased: state.patient.deceasedAt !== null || state.patient.deletedAt !== null,
    }).filter((entry) => current || !REMINDER_TYPES.has(entry.typeCode));
    await this.insertAll(tx, tenantId, planned, state, event.id, eventType === 'appointment.rescheduled' ? 'reactivate_stale' : 'skip', now);
  }

  /** Rattrapage : recrée les rappels attendus manquants, encore à plus de `minLeadMs` de l'envoi (balayeur). */
  async planMissingReminders(tx: TenantTx, tenantId: string, appointmentId: string, now: Date, minLeadMs: number): Promise<number> {
    const state = await this.loadState(tx, tenantId, appointmentId);
    if (!state || !ACTIVE_STATUSES.has(state.appointment.status) || state.appointment.deletedAt !== null) return 0;
    const planned = planAppointmentNotifications({
      eventType: 'appointment.created',
      eventId: state.appointment.id,
      appointmentId: state.appointment.id,
      startsAt: state.appointment.startsAt,
      takenAt: state.appointment.createdAt,
      timeZone: state.timeZone,
      settings: state.settings,
      contact: state.contact,
      deceased: state.patient.deceasedAt !== null || state.patient.deletedAt !== null,
    }).filter((entry) => REMINDER_TYPES.has(entry.typeCode) && entry.scheduledAt.getTime() > now.getTime() + minLeadMs);
    return this.insertAll(tx, tenantId, planned, state, null, 'skip', now);
  }

  private async cancelPendingReminders(tx: TenantTx, tenantId: string, eventType: AppointmentEventType, state: PlanningState, startsAt: Date, current: boolean, now: Date): Promise<void> {
    const appointmentId = state.appointment.id;
    if (eventType === 'appointment.cancelled' || eventType === 'appointment.deleted') {
      await this.notifications.suppressReminders(tx, tenantId, appointmentId, now);
    } else if (eventType === 'appointment.rescheduled' && current) {
      await this.notifications.suppressRemindersOtherThan(tx, tenantId, appointmentId, startsAt.toISOString(), now);
    }
  }

  private async loadState(tx: TenantTx, tenantId: string, appointmentId: string): Promise<PlanningState | null> {
    const appointment = await tx.appointment.findUnique({ where: { tenantId_id: { tenantId, id: appointmentId } }, include: { site: true } });
    if (!appointment) return null;
    const patient = await this.recipients.findPatient(tx, tenantId, appointment.patientId);
    if (!patient) return null;
    const settings = await this.settingsRepo.load(tx, tenantId);
    const tenant = await loadTenantProfile(tx);
    const consents = await this.consents.latestByChannel(tx, tenantId, patient.id);
    const contact: ContactFacts = {
      hasPhone: patient.phoneEnc !== null,
      hasEmail: patient.emailEnc !== null,
      smsConsent: consents.sms?.granted === true,
      emailConsent: consents.email?.granted === true,
    };
    return { appointment, patient, timeZone: appointment.site.timezone ?? tenant.timezone, settings, contact };
  }

  private async insertAll(tx: TenantTx, tenantId: string, planned: readonly PlannedNotification[], state: PlanningState, eventId: string | null, reminderMode: ConflictMode, now: Date): Promise<number> {
    let written = 0;
    for (const entry of planned) {
      const mode = REMINDER_TYPES.has(entry.typeCode) ? reminderMode : 'skip';
      written += await this.notifications.insert(tx, tenantId, this.toRow(tenantId, entry, state, eventId), now, mode);
    }
    return written;
  }

  private toRow(tenantId: string, entry: PlannedNotification, state: PlanningState, eventId: string | null): NewNotification {
    return {
      typeCode: entry.typeCode,
      category: entry.category,
      channel: entry.channel,
      recipientType: 'patient',
      recipientId: state.patient.id,
      subjectType: 'appointment',
      subjectId: state.appointment.id,
      subjectVersion: entry.subjectVersion,
      sourceEventId: eventId,
      dedupKey: dedupKey({ tenantId, sourceKey: entry.sourceKey, typeCode: entry.typeCode, recipientType: 'patient', recipientId: state.patient.id, channel: entry.channel, variant: entry.variant }),
      locale: 'fr',
      context: {},
      suppressionReason: entry.suppressionReason,
      scheduledAt: entry.scheduledAt,
      deadlineAt: entry.deadlineAt,
    };
  }
}
