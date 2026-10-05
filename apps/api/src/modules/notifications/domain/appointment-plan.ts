import { NOTIFICATION_TYPES, type NotificationCategory, type NotificationChannel, type NotificationTypeCode, type SuppressionReason } from '@ghmt/shared';
import { addLocalDays, localDateOf, minutesToLocalTime, parseHhmm, zonedTimeToUtc } from './zoned-time';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** Un RDV pris moins de 24 h à l'avance n'a pas de J-1 ; moins de 3 h, pas de H-2 (docs/10 §5.9). */
export const D1_MIN_LEAD_MS = 24 * HOUR_MS;
export const H2_MIN_LEAD_MS = 3 * HOUR_MS;
const H2_BEFORE_START_MS = 2 * HOUR_MS;
const SMS_DEADLINE_MS = 2 * HOUR_MS;
const EMAIL_DEADLINE_MS = 24 * HOUR_MS;
const D1_DEADLINE_BEFORE_START_MS = 2 * HOUR_MS;
const H2_DEADLINE_BEFORE_START_MS = 30 * MINUTE_MS;

export type AppointmentEventType = 'appointment.created' | 'appointment.rescheduled' | 'appointment.cancelled' | 'appointment.deleted';

export interface PlanSettings {
  readonly appointmentSmsEnabled: boolean;
  readonly reminderD1Enabled: boolean;
  /** `HH:MM` dans le fuseau du site. */
  readonly reminderD1LocalTime: string;
  readonly reminderH2Enabled: boolean;
}

export interface ContactFacts {
  readonly hasPhone: boolean;
  readonly hasEmail: boolean;
  readonly smsConsent: boolean;
  readonly emailConsent: boolean;
}

export interface ChannelChoice {
  readonly channel: NotificationChannel;
  readonly suppressionReason: SuppressionReason | null;
}

const send = (channel: NotificationChannel): ChannelChoice => ({ channel, suppressionReason: null });
const suppress = (channel: NotificationChannel, suppressionReason: SuppressionReason): ChannelChoice => ({ channel, suppressionReason });

/**
 * Canal du patient (docs/10 §5.9). Rappel : consentement explicite par canal (D10). Message transactionnel : exécution du
 * service, sans consentement, mais réglage `appointmentSmsEnabled` pour le SMS. Sans canal possible : ligne supprimée.
 */
export function chooseChannel(category: NotificationCategory, contact: ContactFacts, settings: PlanSettings): ChannelChoice {
  if (!contact.hasPhone && !contact.hasEmail) return suppress('sms', 'no_contact');
  if (category === 'clinical_reminder') {
    if (contact.hasPhone && contact.smsConsent) return send('sms');
    if (contact.hasEmail && contact.emailConsent) return send('email');
    return suppress(contact.hasPhone ? 'sms' : 'email', 'no_consent');
  }
  if (contact.hasPhone && settings.appointmentSmsEnabled) return send('sms');
  if (contact.hasEmail) return send('email');
  return suppress('sms', 'channel_disabled');
}

export interface ReminderTimesInput {
  readonly startsAt: Date;
  /** Instant de la prise de rendez-vous (ou du report). */
  readonly takenAt: Date;
  readonly timeZone: string;
  readonly settings: Pick<PlanSettings, 'reminderD1Enabled' | 'reminderD1LocalTime' | 'reminderH2Enabled'>;
}

/** Instants d'envoi des rappels : J-1 la veille à l'heure locale réglée, H-2 deux heures avant ; null si non planifié. */
export function planReminderTimes(input: ReminderTimesInput): { readonly d1: Date | null; readonly h2: Date | null } {
  const { startsAt, takenAt, timeZone, settings } = input;
  const lead = startsAt.getTime() - takenAt.getTime();
  let d1: Date | null = null;
  if (settings.reminderD1Enabled && lead >= D1_MIN_LEAD_MS) {
    const eve = addLocalDays(localDateOf(startsAt, timeZone), -1);
    const candidate = zonedTimeToUtc(minutesToLocalTime(parseHhmm(settings.reminderD1LocalTime), eve), timeZone);
    // Un J-1 déjà passé au moment de la prise n'est pas envoyé en rafale juste après la confirmation.
    d1 = candidate > takenAt ? candidate : null;
  }
  const h2 = settings.reminderH2Enabled && lead >= H2_MIN_LEAD_MS ? new Date(startsAt.getTime() - H2_BEFORE_START_MS) : null;
  return { d1, h2 };
}

/** Échéance d'un rappel : au-delà, il est inutile (J-1 : RDV − 2 h ; H-2 : RDV − 30 min). */
export function reminderDeadline(typeCode: 'appointment.reminder_d1' | 'appointment.reminder_h2', startsAt: Date): Date {
  const before = typeCode === 'appointment.reminder_d1' ? D1_DEADLINE_BEFORE_START_MS : H2_DEADLINE_BEFORE_START_MS;
  return new Date(startsAt.getTime() - before);
}

export interface DeadlineInput {
  readonly typeCode: NotificationTypeCode;
  readonly category: NotificationCategory;
  readonly channel: NotificationChannel;
  readonly scheduledAt: Date;
  readonly startsAt: Date;
}

/** Échéance de livraison (docs/10 §5.8) : rappels liés à l'heure du RDV, SMS +2 h, e-mail +24 h, in-app aucune. */
export function deliveryDeadline(input: DeadlineInput): Date | null {
  if (input.typeCode === 'appointment.reminder_d1' || input.typeCode === 'appointment.reminder_h2') return reminderDeadline(input.typeCode, input.startsAt);
  if (input.channel === 'sms') return new Date(input.scheduledAt.getTime() + SMS_DEADLINE_MS);
  if (input.channel === 'email') return new Date(input.scheduledAt.getTime() + EMAIL_DEADLINE_MS);
  return null;
}

export interface PlanInput {
  readonly eventType: AppointmentEventType;
  /** Identifiant de l'événement outbox : origine des messages transactionnels. */
  readonly eventId: string;
  readonly appointmentId: string;
  readonly startsAt: Date;
  readonly takenAt: Date;
  readonly timeZone: string;
  readonly settings: PlanSettings;
  readonly contact: ContactFacts;
  readonly deceased?: boolean;
}

export interface PlannedNotification {
  readonly typeCode: NotificationTypeCode;
  readonly category: NotificationCategory;
  readonly channel: NotificationChannel;
  readonly sourceKey: string;
  readonly variant: string;
  readonly subjectVersion: string;
  readonly scheduledAt: Date;
  readonly deadlineAt: Date | null;
  readonly suppressionReason: SuppressionReason | null;
}

const MESSAGE_TYPES: Readonly<Record<AppointmentEventType, NotificationTypeCode | null>> = {
  'appointment.created': 'appointment.confirmed',
  'appointment.rescheduled': 'appointment.rescheduled',
  'appointment.cancelled': 'appointment.cancelled',
  'appointment.deleted': null,
};
const EVENTS_WITH_REMINDERS: ReadonlySet<AppointmentEventType> = new Set(['appointment.created', 'appointment.rescheduled']);

function entry(input: PlanInput, typeCode: NotificationTypeCode, scheduledAt: Date, source: { sourceKey: string; variant: string }): PlannedNotification {
  const category = NOTIFICATION_TYPES[typeCode].category;
  const choice = chooseChannel(category, input.contact, input.settings);
  return {
    typeCode,
    category,
    channel: choice.channel,
    sourceKey: source.sourceKey,
    variant: source.variant,
    subjectVersion: input.startsAt.toISOString(),
    scheduledAt,
    deadlineAt: deliveryDeadline({ typeCode, category, channel: choice.channel, scheduledAt, startsAt: input.startsAt }),
    suppressionReason: input.deceased ? 'recipient_inactive' : choice.suppressionReason,
  };
}

/** Notifications à créer pour un événement de rendez-vous (docs/10 §5.9). Pure : l'appelant fournit l'état lu en base. */
export function planAppointmentNotifications(input: PlanInput): PlannedNotification[] {
  const planned: PlannedNotification[] = [];
  const messageType = MESSAGE_TYPES[input.eventType];
  if (messageType) planned.push(entry(input, messageType, input.takenAt, { sourceKey: input.eventId, variant: '' }));
  if (!EVENTS_WITH_REMINDERS.has(input.eventType)) return planned;
  const reminderSource = { sourceKey: input.appointmentId, variant: input.startsAt.toISOString() };
  const times = planReminderTimes(input);
  if (times.d1) planned.push(entry(input, 'appointment.reminder_d1', times.d1, reminderSource));
  if (times.h2) planned.push(entry(input, 'appointment.reminder_h2', times.h2, reminderSource));
  return planned;
}
