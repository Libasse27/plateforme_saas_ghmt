/**
 * Contrats des notifications (équipe N, docs/10-phase-notifications-admin.md §7.1).
 * Pas d'import de ./index ici (dépendance circulaire à l'évaluation).
 */
import { z } from 'zod';
import { isoDateTime, phoneE164 } from './primitives';

// ───────── Constantes ─────────
export const NOTIFICATION_CHANNELS = ['email', 'sms', 'inapp'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

export const NOTIFICATION_STATUSES = ['queued', 'sent', 'delivered', 'failed', 'suppressed'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const NOTIFICATION_CATEGORIES = ['transactional', 'clinical_reminder', 'administrative'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const SUPPRESSION_REASONS = [
  'no_consent',
  'no_contact',
  'preference_disabled',
  'channel_disabled',
  'quota_exhausted',
  'stale',
  'appointment_cancelled',
  'invoice_settled',
  'too_late',
  'provider_unavailable',
  'recipient_inactive',
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export const NOTIFICATION_LOCALES = ['fr', 'en'] as const;
export type NotificationLocale = (typeof NOTIFICATION_LOCALES)[number];

export const CONSENT_CHANNELS = ['sms', 'email'] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];
export const CONSENT_PURPOSES = ['appointment_reminder'] as const;
export type ConsentPurpose = (typeof CONSENT_PURPOSES)[number];
export const CONSENT_SOURCES = ['front_desk', 'patient_request', 'sms_stop', 'phone_change'] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

export const SMS_PROVIDERS = ['none', 'sandbox', 'http'] as const;
export type SmsProviderName = (typeof SMS_PROVIDERS)[number];

// ───────── Catalogue figé des types (docs/10 §7.1) ─────────
const APPOINTMENT_VARIABLES = ['etablissement.nom', 'site.nom', 'patient.prenom', 'rdv.date', 'rdv.heure'] as const;
const INVOICE_VARIABLES = ['etablissement.nom', 'facture.numero', 'facture.montant', 'facture.echeance', 'facture.jours_retard', 'lien'] as const;
const QUOTA_VARIABLES = ['etablissement.nom', 'quota.pourcentage', 'quota.limite', 'lien'] as const;

export interface NotificationTypeDefinition {
  readonly category: NotificationCategory;
  readonly recipient: 'patient' | 'user';
  readonly channels: readonly NotificationChannel[];
  readonly variables: readonly string[];
}

const patientType = (category: NotificationCategory): NotificationTypeDefinition => ({
  category,
  recipient: 'patient',
  channels: ['sms', 'email'],
  variables: APPOINTMENT_VARIABLES,
});

const invoiceType: NotificationTypeDefinition = {
  category: 'administrative',
  recipient: 'user',
  channels: ['email', 'inapp'],
  variables: INVOICE_VARIABLES,
};

export const NOTIFICATION_TYPES = {
  'appointment.confirmed': patientType('transactional'),
  'appointment.rescheduled': patientType('transactional'),
  'appointment.cancelled': patientType('transactional'),
  'appointment.reminder_d1': patientType('clinical_reminder'),
  'appointment.reminder_h2': patientType('clinical_reminder'),
  'subscription.invoice_issued': invoiceType,
  'subscription.payment_reminder': invoiceType,
  'subscription.payment_overdue': invoiceType,
  'subscription.suspension_notice': invoiceType,
  'quota.sms_threshold': { category: 'administrative', recipient: 'user', channels: ['email', 'inapp'], variables: QUOTA_VARIABLES },
} as const satisfies Record<string, NotificationTypeDefinition>;

export type NotificationTypeCode = keyof typeof NOTIFICATION_TYPES;
export const NOTIFICATION_TYPE_CODES = Object.keys(NOTIFICATION_TYPES) as readonly NotificationTypeCode[];

const typeCode = z.enum(NOTIFICATION_TYPE_CODES as [NotificationTypeCode, ...NotificationTypeCode[]]);
const channel = z.enum(NOTIFICATION_CHANNELS);
const locale = z.enum(NOTIFICATION_LOCALES);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'heure au format HH:MM');
const cursor = z.string().max(200).optional();

// ───────── Boîte in-app et préférences ─────────
export const listInboxQuerySchema = z.object({
  unreadOnly: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor,
});
export type ListInboxQuery = z.infer<typeof listInboxQuerySchema>;

export const updateNotificationPreferencesSchema = z.object({
  items: z
    .array(z.object({ category: z.literal('administrative'), channel: z.enum(['email', 'inapp']), enabled: z.boolean() }))
    .min(1)
    .max(10),
});
export type UpdateNotificationPreferencesInput = z.infer<typeof updateNotificationPreferencesSchema>;

// ───────── Paramètres de l'établissement ─────────
export const updateNotificationSettingsSchema = z
  .object({
    quietHoursStart: hhmm.optional(),
    quietHoursEnd: hhmm.optional(),
    smsTransliterate: z.boolean().optional(),
    senderDisplayName: z.string().trim().min(2).max(30).nullable().optional(),
    appointmentSmsEnabled: z.boolean().optional(),
    reminderD1Enabled: z.boolean().optional(),
    reminderD1LocalTime: hhmm.optional(),
    reminderH2Enabled: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), { message: 'Au moins un champ à modifier est requis.' });
export type UpdateNotificationSettingsInput = z.infer<typeof updateNotificationSettingsSchema>;

// ───────── Modèles ─────────
const templateBody = z.string().min(1).max(5000);
const templateSubject = z.string().max(150);

export const listNotificationTemplatesQuerySchema = z.object({ typeCode: typeCode.optional() });
export type ListNotificationTemplatesQuery = z.infer<typeof listNotificationTemplatesQuerySchema>;

export const upsertNotificationTemplateSchema = z.object({ subject: templateSubject.optional(), body: templateBody });
export type UpsertNotificationTemplateInput = z.infer<typeof upsertNotificationTemplateSchema>;

export const previewNotificationTemplateSchema = z.object({
  typeCode,
  channel,
  locale,
  subject: templateSubject.optional(),
  body: templateBody,
});
export type PreviewNotificationTemplateInput = z.infer<typeof previewNotificationTemplateSchema>;

// ───────── Journal des envois ─────────
export const listDeliveriesQuerySchema = z
  .object({
    status: z.enum(NOTIFICATION_STATUSES).optional(),
    channel: channel.optional(),
    typeCode: typeCode.optional(),
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    cursor,
  })
  .refine((v) => v.from === undefined || v.to === undefined || new Date(v.to) > new Date(v.from), {
    message: 'to doit être postérieur à from.',
    path: ['to'],
  });
export type ListDeliveriesQuery = z.infer<typeof listDeliveriesQuerySchema>;

// ───────── Consentement du patient ─────────
export const recordContactConsentSchema = z.object({
  channel: z.enum(CONSENT_CHANNELS),
  purpose: z.enum(CONSENT_PURPOSES),
  granted: z.boolean(),
  source: z.enum(['front_desk', 'patient_request']),
});
export type RecordContactConsentInput = z.infer<typeof recordContactConsentSchema>;

// ───────── Webhooks SMS ─────────
const UUID_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

export const smsDeliveryWebhookSchema = z.object({
  clientRef: z.string().regex(new RegExp(`^${UUID_PATTERN}\\.${UUID_PATTERN}$`), 'clientRef au format <tenantId>.<notificationId>'),
  status: z.enum(['delivered', 'undeliverable', 'failed']),
  providerMessageId: z.string().max(100).optional(),
  errorCode: z.string().max(50).optional(),
});
export type SmsDeliveryWebhookInput = z.infer<typeof smsDeliveryWebhookSchema>;

export const smsInboundWebhookSchema = z.object({
  from: phoneE164,
  text: z.string().max(1600),
  receivedAt: isoDateTime.optional(),
});
export type SmsInboundWebhookInput = z.infer<typeof smsInboundWebhookSchema>;

// ───────── Vues ─────────
export interface InAppMessageView {
  readonly id: string;
  readonly typeCode: string;
  readonly title: string;
  readonly body: string;
  readonly link: string | null;
  readonly createdAt: string;
  readonly readAt: string | null;
}

export interface UnreadCountView {
  readonly count: number;
  readonly capped: boolean;
}

export interface NotificationPreferenceView {
  readonly category: 'administrative';
  readonly channel: 'email' | 'inapp';
  readonly enabled: boolean;
  readonly locked: boolean;
  readonly note: string | null;
}

export interface NotificationSettingsView {
  readonly quietHoursStart: string;
  readonly quietHoursEnd: string;
  readonly smsTransliterate: boolean;
  readonly senderDisplayName: string | null;
  readonly appointmentSmsEnabled: boolean;
  readonly reminderD1Enabled: boolean;
  readonly reminderD1LocalTime: string;
  readonly reminderH2Enabled: boolean;
  readonly smsProvider: SmsProviderName;
  readonly smsUsage: { readonly month: string; readonly usedSegments: number; readonly limit: number | null };
  readonly updatedAt: string | null;
}

export interface NotificationTemplateView {
  readonly typeCode: NotificationTypeCode;
  readonly channel: NotificationChannel;
  readonly locale: NotificationLocale;
  readonly source: 'default' | 'custom';
  readonly version: number;
  readonly subject: string | null;
  readonly body: string;
  readonly variables: readonly string[];
  readonly updatedAt: string | null;
}

export interface TemplateIssueView {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface TemplatePreviewView {
  readonly subject: string | null;
  readonly body: string;
  readonly characters: number;
  readonly segments: number | null;
  readonly encoding: 'GSM7' | 'UCS2' | null;
  readonly issues: readonly TemplateIssueView[];
}

export interface NotificationDeliveryView {
  readonly id: string;
  readonly typeCode: string;
  readonly channel: NotificationChannel;
  readonly status: NotificationStatus;
  readonly suppressionReason: SuppressionReason | null;
  readonly recipientType: 'user' | 'patient';
  readonly recipientMasked: string | null;
  readonly subjectType: string | null;
  readonly subjectId: string | null;
  readonly attempts: number;
  readonly errorClass: string | null;
  readonly errorCode: string | null;
  readonly provider: string | null;
  readonly createdAt: string;
  readonly scheduledAt: string;
  readonly sentAt: string | null;
  readonly deliveredAt: string | null;
}

export interface ContactConsentEntry {
  readonly id: string;
  readonly channel: ConsentChannel;
  readonly purpose: ConsentPurpose;
  readonly granted: boolean;
  readonly source: ConsentSource;
  readonly recordedAt: string;
}

export interface ContactConsentCurrent {
  readonly channel: ConsentChannel;
  readonly purpose: ConsentPurpose;
  readonly granted: boolean;
  readonly source: ConsentSource | null;
  readonly recordedAt: string | null;
}

export interface ContactConsentsView {
  readonly patientId: string;
  readonly current: readonly ContactConsentCurrent[];
  readonly history: readonly ContactConsentEntry[];
}
