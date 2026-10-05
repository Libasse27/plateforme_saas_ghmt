import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { FieldCrypto } from '../../src/common/crypto/field-crypto.service';
import { Clock } from '../../src/common/time/clock';
import type { Notification, NotificationOutboxEvent, Prisma } from '../../src/generated/prisma/client';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createPractitionerRow } from '../appointments/appointment-fixtures';
import type { TenantFixture, UserFixture } from '../helpers/fixtures';
import { MutableClock } from '../helpers/mutable-clock';
import type { ProviderOverride } from '../helpers/test-app';

export const API = '/api/v1';
export const HOUR_MS = 3_600_000;
export const MINUTE_MS = 60_000;
export const DAY_MS = 24 * HOUR_MS;
export const PATIENT_PHONE = '+221771234545';
export const PATIENT_EMAIL = 'awa.patiente@exemple.sn';
export const SECRET_REASON = 'consultation VIH confidentielle';

export const http = (app: INestApplication): ReturnType<typeof request> => request(app.getHttpServer());
export const bearer = (token: string): { Authorization: string } => ({ Authorization: `Bearer ${token}` });

/** Horloge pilotable (réglée sur l'heure réelle au départ) à injecter dans `createTestApp`. */
export function createClockOverrides(): { clock: MutableClock; overrides: readonly ProviderOverride[] } {
  const clock = new MutableClock();
  return { clock, overrides: [{ token: Clock, useValue: clock }] };
}

export interface PatientSeed {
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly deceasedAt?: Date;
  readonly primarySiteId?: string;
}

/** Patient dont le téléphone et l'e-mail sont chiffrés comme le fait le module patients. */
export async function createPatientWithContacts(app: INestApplication, tenant: TenantFixture, seed: PatientSeed = {}): Promise<string> {
  const crypto = app.get(FieldCrypto);
  const suffix = randomBytes(4).toString('hex');
  const phone = seed.phone === undefined ? PATIENT_PHONE : seed.phone;
  const email = seed.email === undefined ? PATIENT_EMAIL : seed.email;
  const lastName = seed.lastName ?? `Notif${suffix}`;
  const firstName = seed.firstName ?? 'Awa';
  const patient = await app.get(TenantDb).runAs(tenant.tenantId, (tx) =>
    tx.patient.create({
      data: {
        tenantId: tenant.tenantId,
        ipp: `NOTIF-${suffix}`,
        lastName,
        firstName,
        searchName: `${lastName} ${firstName}`.toLowerCase(),
        phoneEnc: phone ? crypto.encrypt(tenant.tenantId, phone) : undefined,
        phoneBidx: phone ? crypto.blindIndex(tenant.tenantId, phone) : undefined,
        emailEnc: email ? crypto.encrypt(tenant.tenantId, email) : undefined,
        emailBidx: email ? crypto.blindIndex(tenant.tenantId, email) : undefined,
        deceasedAt: seed.deceasedAt,
        primarySiteId: seed.primarySiteId,
      },
      select: { id: true },
    }),
  );
  return patient.id;
}

/** Consentement enregistré directement en base (le test HTTP du consentement vit dans consents.e2e-spec). */
export async function recordConsent(
  app: INestApplication,
  tenant: TenantFixture,
  patientId: string,
  channel: 'sms' | 'email',
  granted = true,
): Promise<void> {
  await app.get(TenantDb).runAs(tenant.tenantId, (tx) =>
    tx.patientContactConsent.create({
      data: { tenantId: tenant.tenantId, patientId, channel, purpose: 'appointment_reminder', granted, source: 'front_desk', recordedBy: tenant.adminUserId },
    }),
  );
}

export interface BookingOptions {
  readonly patientId: string;
  readonly startsAt: Date;
  readonly durationMinutes?: number;
  readonly practitionerId?: string;
  readonly siteId?: string;
  readonly reason?: string;
}

/** Prend un rendez-vous par l'API (donc par l'outbox transactionnelle). */
export async function bookAppointment(app: INestApplication, tenant: TenantFixture, user: UserFixture, options: BookingOptions): Promise<string> {
  const practitionerId = options.practitionerId ?? (await createPractitionerRow(app, tenant));
  const endsAt = new Date(options.startsAt.getTime() + (options.durationMinutes ?? 30) * MINUTE_MS);
  const res = await http(app)
    .post(`${API}/appointments`)
    .set(bearer(user.token))
    .send({
      patientId: options.patientId,
      practitionerId,
      siteId: options.siteId ?? tenant.mainSiteId,
      startsAt: options.startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      reason: options.reason ?? SECRET_REASON,
    })
    .expect(201);
  return (res.body.data as { id: string }).id;
}

export function notificationsOf(app: INestApplication, tenant: Pick<TenantFixture, 'tenantId'>, where: Prisma.NotificationWhereInput = {}): Promise<Notification[]> {
  return app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.notification.findMany({ where, orderBy: [{ scheduledAt: 'asc' }, { id: 'asc' }] }));
}

export function outboxOf(app: INestApplication, tenant: Pick<TenantFixture, 'tenantId'>, where: Prisma.NotificationOutboxEventWhereInput = {}): Promise<NotificationOutboxEvent[]> {
  return app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.notificationOutboxEvent.findMany({ where, orderBy: { id: 'asc' } }));
}

/** Ligne de notification d'un type et d'un canal pour un rendez-vous. */
export async function findNotification(
  app: INestApplication,
  tenant: Pick<TenantFixture, 'tenantId'>,
  appointmentId: string,
  typeCode: string,
  channel?: string,
): Promise<Notification> {
  const rows = await notificationsOf(app, tenant, { subjectId: appointmentId, typeCode, ...(channel ? { channel } : {}) });
  const row = rows[rows.length - 1];
  if (!row) throw new Error(`Notification ${typeCode} introuvable pour ${appointmentId}`);
  return row;
}

/** Instant « J jours avant le RDV à `hhmmUtc` » : repères lisibles pour les tests de planification (fuseau Africa/Dakar = UTC). */
export function utcAt(start: Date, dayOffset: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + dayOffset, hour, minute));
}

/** Rendez-vous d'essai : toujours dans ~15 jours à 14:00 UTC (assez loin pour avoir J-1 et H-2). */
export function futureStart(daysAhead = 15, hour = 14): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysAhead, hour, 0));
}

/**
 * Fixe l'instant de « prise » des événements d'outbox en attente : `created_at` vient de l'horloge de la base, que les tests
 * ne pilotent pas. Rend les règles de 24 h / 3 h et les plages silencieuses indépendantes de l'heure réelle d'exécution.
 */
export async function rebasePendingOutbox(app: INestApplication, tenant: Pick<TenantFixture, 'tenantId'>, takenAt: Date): Promise<void> {
  await app.get(TenantDb).runAs(tenant.tenantId, (tx) =>
    tx.notificationOutboxEvent.updateMany({ where: { status: 'pending' }, data: { createdAt: takenAt, availableAt: takenAt } }),
  );
}

/** Rend un événement déjà traité à nouveau `pending` (rejeu). */
export async function replayOutbox(app: INestApplication, tenant: Pick<TenantFixture, 'tenantId'>, aggregateId: string): Promise<void> {
  await app.get(TenantDb).runAs(tenant.tenantId, (tx) =>
    tx.notificationOutboxEvent.updateMany({ where: { aggregateId }, data: { status: 'pending', processedAt: null, availableAt: new Date(0) } }),
  );
}

export async function setSiteTimezone(app: INestApplication, tenant: TenantFixture, siteId: string, timezone: string): Promise<void> {
  await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.site.update({ where: { tenantId_id: { tenantId: tenant.tenantId, id: siteId } }, data: { timezone } }));
}

export async function updateSettings(app: INestApplication, tenant: TenantFixture, data: Prisma.NotificationSettingsUncheckedUpdateInput): Promise<void> {
  await app.get(TenantDb).runAs(tenant.tenantId, (tx) =>
    tx.notificationSettings.upsert({ where: { tenantId: tenant.tenantId }, create: { tenantId: tenant.tenantId, ...(data as Prisma.NotificationSettingsUncheckedCreateInput) }, update: data }),
  );
}

export async function reschedule(app: INestApplication, user: UserFixture, appointmentId: string, startsAt: Date): Promise<void> {
  await http(app)
    .patch(`${API}/appointments/${appointmentId}/reschedule`)
    .set(bearer(user.token))
    .send({ startsAt: startsAt.toISOString(), endsAt: new Date(startsAt.getTime() + 30 * MINUTE_MS).toISOString() })
    .expect(200);
}

export async function cancelAppointment(app: INestApplication, user: UserFixture, appointmentId: string): Promise<void> {
  await http(app).post(`${API}/appointments/${appointmentId}/status`).set(bearer(user.token)).send({ status: 'cancelled', cancelReason: 'Annulation de test' }).expect(200);
}

export interface SeedNotification {
  readonly typeCode?: string;
  readonly channel?: 'email' | 'sms' | 'inapp';
  readonly status?: 'queued' | 'sent' | 'delivered' | 'failed' | 'suppressed';
  readonly recipientType?: 'user' | 'patient';
  readonly recipientId?: string;
  readonly createdAt?: Date;
  readonly suppressionReason?: string;
  readonly recipientMasked?: string;
  readonly subjectId?: string;
}

/** Ligne de journal insérée directement (tests des listes et filtres) ; la clé de déduplication est unique par appel. */
export async function seedNotification(app: INestApplication, tenant: Pick<TenantFixture, 'tenantId' | 'adminUserId'>, seed: SeedNotification = {}): Promise<Notification> {
  const createdAt = seed.createdAt ?? new Date();
  const status = seed.status ?? 'sent';
  return app.get(TenantDb).runAs(tenant.tenantId, (tx) =>
    tx.notification.create({
      data: {
        tenantId: tenant.tenantId,
        typeCode: seed.typeCode ?? 'appointment.confirmed',
        category: 'transactional',
        channel: seed.channel ?? 'sms',
        recipientType: seed.recipientType ?? 'patient',
        recipientId: seed.recipientId ?? tenant.adminUserId,
        subjectType: seed.subjectId ? 'appointment' : null,
        subjectId: seed.subjectId ?? null,
        dedupKey: randomBytes(32).toString('hex'),
        locale: 'fr',
        status,
        suppressionReason: status === 'suppressed' ? (seed.suppressionReason ?? 'no_contact') : null,
        scheduledAt: createdAt,
        nextAttemptAt: createdAt,
        recipientMasked: seed.recipientMasked ?? '+22177*****45',
        createdAt,
        updatedAt: createdAt,
      },
    }),
  );
}
