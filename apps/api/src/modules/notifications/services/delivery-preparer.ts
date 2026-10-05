import { Inject, Injectable } from '@nestjs/common';
import { NOTIFICATION_TYPES, type NotificationCategory, type NotificationChannel, type NotificationLocale, type NotificationTypeCode, type SuppressionReason } from '@ghmt/shared';
import { FieldCrypto } from '../../../common/crypto/field-crypto.service';
import type { Appointment, Notification, Patient, Site, User } from '../../../generated/prisma/client';
import { ENV, type Env } from '../../../infrastructure/config/env';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { loadTenantProfile } from '../../../infrastructure/tenancy/tenant-profile';
import { deliveryDeadline } from '../domain/appointment-plan';
import { dedupKey } from '../domain/dedup-key';
import { decideEarly, type DecisionInput, type EarlyOutcome } from '../domain/delivery-decision';
import { appointmentVariables, invoiceVariables, quotaVariables, type InvoiceContext, type QuotaContext } from '../domain/message-variables';
import { deferForQuietHours } from '../domain/quiet-hours';
import { SMS_MAX_SEGMENTS } from '../domain/sms-encoding';
import { TemplateRenderError } from '../domain/template-engine';
import { H2_TOO_LATE_MS, INAPP_LINK_SUBSCRIPTION, SMS_RETRY_WINDOW_MS } from '../notifications.constants';
import { SMS_PROVIDER_TOKEN, type SmsProvider } from '../providers/sms-provider';
import { ConsentsRepository, type CurrentConsents } from '../repositories/consents.repository';
import { NotificationsRepository } from '../repositories/notifications.repository';
import { RecipientsRepository } from '../repositories/recipients.repository';
import { SettingsRepository } from '../repositories/settings.repository';
import type { EffectiveSettings } from '../mappers/settings.mapper';
import type { PreparedSend } from './channel-sender';
import { DeliveryRecorder } from './delivery-recorder';
import { MessageComposer, type ComposedMessage } from './message-composer';
import { SmsQuotaService } from './sms-quota.service';

type FallbackVariant = 'provider_fallback' | 'quota_fallback';
type Outcome = EarlyOutcome | { readonly kind: 'defer'; readonly until: Date; readonly deadlineAt?: Date };
type SuppressOutcome = { readonly kind: 'suppress'; readonly reason: SuppressionReason; readonly fallback?: FallbackVariant };

interface Facts {
  readonly settings: EffectiveSettings;
  readonly tenantName: string;
  readonly timeZone: string;
  readonly appointment: (Appointment & { site: Site }) | null;
  readonly patient: Patient | null;
  readonly user: User | null;
  readonly address: string | null;
  readonly consents: CurrentConsents | null;
  readonly emailPreferenceEnabled: boolean;
}

const typeOf = (row: Notification): NotificationTypeCode => row.typeCode as NotificationTypeCode;
const localeOf = (row: Notification): NotificationLocale => (row.locale === 'en' ? 'en' : 'fr');

/**
 * Préparation d'un envoi (docs/10 §5.8 b), dans UNE transaction : fraîcheur, destinataire actif, consentement, préférence,
 * plage silencieuse (SMS), rendu, contrôle du quota. Toute issue autre qu'un envoi est enregistrée ici (suppression, échec,
 * report, remise in-app) et la méthode renvoie `null` ; sinon elle renvoie de quoi appeler le fournisseur HORS transaction.
 */
@Injectable()
export class DeliveryPreparer {
  constructor(
    private readonly recipients: RecipientsRepository,
    private readonly settings: SettingsRepository,
    private readonly consents: ConsentsRepository,
    private readonly composer: MessageComposer,
    private readonly quota: SmsQuotaService,
    private readonly recorder: DeliveryRecorder,
    private readonly notifications: NotificationsRepository,
    private readonly crypto: FieldCrypto,
    @Inject(ENV) private readonly env: Env,
    @Inject(SMS_PROVIDER_TOKEN) private readonly sms: SmsProvider,
  ) {}

  async prepare(tx: TenantTx, row: Notification, now: Date): Promise<PreparedSend | null> {
    const facts = await this.loadFacts(tx, row);
    const early = decideEarly(this.decisionInput(row, facts, now));
    if (early) return this.finish(tx, row, early, facts, now);
    const gate = row.channel === 'sms' ? this.smsGate(row, facts, now) : null;
    if (gate) return this.finish(tx, row, gate, facts, now);

    const message = await this.render(tx, row, facts, now);
    if ('kind' in message) return this.finish(tx, row, message, facts, now);
    if (row.channel === 'inapp') return this.deliverInApp(tx, row, message, now);
    if (row.channel === 'sms') {
      const refusal = await this.reserveQuota(tx, row, message, now);
      if (refusal) return this.finish(tx, row, refusal, facts, now);
    }
    await this.recorder.markPrepared(tx, row, message, now);
    return { tenantId: row.tenantId, notificationId: row.id, channel: row.channel as 'email' | 'sms', address: facts.address as string, message };
  }

  private async loadFacts(tx: TenantTx, row: Notification): Promise<Facts> {
    const settings = await this.settings.load(tx, row.tenantId);
    const tenant = await loadTenantProfile(tx);
    const appointment =
      row.subjectType === 'appointment' && row.subjectId
        ? await tx.appointment.findUnique({ where: { tenantId_id: { tenantId: row.tenantId, id: row.subjectId } }, include: { site: true } })
        : null;
    const patient = row.recipientType === 'patient' ? await this.recipients.findPatient(tx, row.tenantId, row.recipientId) : null;
    const user = row.recipientType === 'user' ? await this.recipients.findUser(tx, row.tenantId, row.recipientId) : null;
    const consents = patient && row.category === 'clinical_reminder' ? await this.consents.latestByChannel(tx, row.tenantId, patient.id) : null;
    const emailPreferenceEnabled = user ? await this.recipients.isEmailEnabled(tx, row.tenantId, user.id) : true;
    return {
      settings,
      tenantName: tenant.name,
      timeZone: appointment?.site.timezone ?? tenant.timezone,
      appointment,
      patient,
      user,
      address: this.addressOf(row, patient, user),
      consents,
      emailPreferenceEnabled,
    };
  }

  /** Adresse déchiffrée en mémoire pour le canal de la notification (jamais stockée ni journalisée). */
  private addressOf(row: Notification, patient: Patient | null, user: User | null): string | null {
    if (row.channel === 'inapp') return null;
    if (user) return row.channel === 'email' ? user.email : null;
    const blob = row.channel === 'sms' ? patient?.phoneEnc : patient?.emailEnc;
    return blob ? this.crypto.decrypt(row.tenantId, blob) : null;
  }

  private decisionInput(row: Notification, facts: Facts, now: Date): DecisionInput {
    const { patient, user } = facts;
    const active = patient ? patient.deletedAt === null && patient.deceasedAt === null : user ? user.deletedAt === null && user.status === 'active' : false;
    return {
      now,
      typeCode: typeOf(row),
      category: row.category as NotificationCategory,
      channel: row.channel as NotificationChannel,
      deadlineAt: row.deadlineAt,
      subjectVersion: row.subjectVersion,
      appointment: facts.appointment,
      expectsAppointment: row.subjectType === 'appointment',
      recipientActive: active,
      address: facts.address,
      consentGranted: facts.consents?.[row.channel === 'email' ? 'email' : 'sms']?.granted === true,
      emailPreferenceEnabled: facts.emailPreferenceEnabled,
      appointmentSmsEnabled: facts.settings.appointmentSmsEnabled,
    };
  }

  /** Contrôles propres au SMS : fournisseur disponible, puis plage silencieuse (docs/10 D9). */
  private smsGate(row: Notification, facts: Facts, now: Date): Outcome | null {
    if (this.sms.name === 'none') return { kind: 'suppress', reason: 'provider_unavailable', fallback: 'provider_fallback' } as SuppressOutcome;
    const hours = { start: facts.settings.quietHoursStart, end: facts.settings.quietHoursEnd };
    const until = deferForQuietHours(now, facts.timeZone, hours, row.id);
    if (until === null) return null;
    const startsAt = row.subjectVersion ? new Date(row.subjectVersion) : null;
    if (row.typeCode === 'appointment.reminder_h2' && startsAt && until.getTime() > startsAt.getTime() - H2_TOO_LATE_MS) return { kind: 'suppress', reason: 'too_late' };
    if (row.category === 'clinical_reminder') {
      return row.deadlineAt !== null && until > row.deadlineAt ? { kind: 'fail', errorCode: 'deadline_exceeded', errorClass: null } : { kind: 'defer', until };
    }
    // Message transactionnel de nuit : la fenêtre de retry (2 h) repart de l'heure d'envoi reportée.
    return { kind: 'defer', until, deadlineAt: new Date(until.getTime() + SMS_RETRY_WINDOW_MS) };
  }

  private async render(tx: TenantTx, row: Notification, facts: Facts, now: Date): Promise<ComposedMessage | EarlyOutcome> {
    try {
      const values = this.valuesOf(row, facts, now);
      return await this.composer.compose(tx, row.tenantId, {
        typeCode: typeOf(row),
        channel: row.channel as NotificationChannel,
        locale: localeOf(row),
        values,
        transliterate: facts.settings.smsTransliterate,
      });
    } catch (error: unknown) {
      if (!(error instanceof TemplateRenderError)) throw error;
      return { kind: 'fail', errorCode: 'render_error', errorClass: null };
    }
  }

  private valuesOf(row: Notification, facts: Facts, now: Date): Record<string, string> {
    const { settings } = facts;
    const base = { tenantName: facts.tenantName, senderDisplayName: settings.senderDisplayName };
    const link = `${this.env.WEB_URL}${INAPP_LINK_SUBSCRIPTION}`;
    if (row.typeCode.startsWith('appointment.')) {
      if (!facts.appointment || !facts.patient || !row.subjectVersion) throw new TemplateRenderError('appointment');
      return appointmentVariables({ ...base, siteName: facts.appointment.site.name, patientFirstName: facts.patient.firstName, startsAt: new Date(row.subjectVersion), timeZone: facts.timeZone, locale: localeOf(row) });
    }
    if (row.typeCode.startsWith('subscription.')) {
      return invoiceVariables(row.context as unknown as InvoiceContext, { ...base, timeZone: facts.timeZone, locale: localeOf(row), now, link });
    }
    return quotaVariables(row.context as unknown as QuotaContext, { ...base, link });
  }

  private async deliverInApp(tx: TenantTx, row: Notification, message: ComposedMessage, now: Date): Promise<null> {
    const isBilling = row.typeCode.startsWith('subscription.') || row.typeCode.startsWith('quota.');
    await this.recorder.markPrepared(tx, row, message, now);
    await this.recorder.deliverInApp(tx, row, { title: clip(message.subject ?? '', 120), body: clip(message.text, 500), link: isBilling ? INAPP_LINK_SUBSCRIPTION : null }, now);
    return null;
  }

  /** Segments > 3 : échec de configuration ; quota épuisé : suppression avec repli e-mail. */
  private async reserveQuota(tx: TenantTx, row: Notification, message: ComposedMessage, now: Date): Promise<Outcome | null> {
    const segments = message.sms?.segments ?? 0;
    if (segments > SMS_MAX_SEGMENTS) return { kind: 'fail', errorCode: 'too_many_segments', errorClass: null };
    const decision = await this.quota.reserve(tx, row.tenantId, row.id, segments, now);
    return decision.allowed ? null : ({ kind: 'suppress', reason: 'quota_exhausted', fallback: 'quota_fallback' } as SuppressOutcome);
  }

  private async finish(tx: TenantTx, row: Notification, outcome: Outcome | SuppressOutcome, facts: Facts, now: Date): Promise<null> {
    if (outcome.kind === 'defer') await this.recorder.defer(tx, row, outcome.until, now, outcome.deadlineAt);
    else if (outcome.kind === 'fail') await this.recorder.fail(tx, row, { errorCode: outcome.errorCode, errorClass: outcome.errorClass ?? (outcome.errorCode === 'render_error' ? 'permanent_config' : null) }, now);
    else {
      await this.recorder.suppress(tx, row, outcome.reason, now);
      const fallback = 'fallback' in outcome ? outcome.fallback : undefined;
      if (fallback) await this.createEmailFallback(tx, row, facts, fallback, now);
    }
    return null;
  }

  /** Repli e-mail d'un SMS non envoyé, si le patient a une adresse (et, pour un rappel, un consentement e-mail). */
  private async createEmailFallback(tx: TenantTx, row: Notification, facts: Facts, variant: FallbackVariant, now: Date): Promise<void> {
    const { patient } = facts;
    if (!patient?.emailEnc || row.channel !== 'sms') return;
    if (row.category === 'clinical_reminder' && facts.consents?.email?.granted !== true) return;
    const typeCode = typeOf(row);
    const startsAt = row.subjectVersion ? new Date(row.subjectVersion) : now;
    await this.notifications.insert(tx, row.tenantId, {
      typeCode,
      category: NOTIFICATION_TYPES[typeCode].category,
      channel: 'email',
      recipientType: 'patient',
      recipientId: row.recipientId,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      subjectVersion: row.subjectVersion,
      sourceEventId: row.sourceEventId,
      dedupKey: dedupKey({ tenantId: row.tenantId, sourceKey: row.dedupKey, typeCode, recipientType: 'patient', recipientId: row.recipientId, channel: 'email', variant }),
      locale: localeOf(row),
      context: row.context as Record<string, unknown>,
      suppressionReason: null,
      scheduledAt: now,
      deadlineAt: deliveryDeadline({ typeCode, category: NOTIFICATION_TYPES[typeCode].category, channel: 'email', scheduledAt: now, startsAt }),
    }, now);
  }
}

function clip(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
