import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { runDispatcher, sandboxOf } from './dispatch-fixtures';
import { MINUTE_MS, PATIENT_EMAIL, bookAppointment, createClockOverrides, createPatientWithContacts, futureStart, notificationsOf, rebasePendingOutbox, utcAt } from './notification-fixtures';

const LIMIT = 5;

describe('quota SMS du plan', () => {
  let app: INestApplication;
  let tenant: TenantFixture;
  let receptionist: UserFixture;
  let patientId: string;

  beforeAll(async () => {
    app = await createTestApp({}, { providerOverrides: createClockOverrides().overrides });
    tenant = await createTenantFixture(app, { prefix: 'quota', subscriptionPlan: 'basic' });
    await app.get(PlatformDb).run((db) => db.subscription.update({ where: { tenantId: tenant.tenantId }, data: { overrides: { limits: { smsMonthly: LIMIT } } } }));
    receptionist = await createUserWithRole(app, tenant, 'receptionist');
    patientId = await createPatientWithContacts(app, tenant);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('suppression quota_exhausted avec repli e-mail, et alertes à 80 % et 100 % émises une seule fois', async () => {
    const taken = utcAt(futureStart(50, 14), -5, 11);
    for (let i = 0; i < LIMIT + 1; i += 1) await bookAppointment(app, tenant, receptionist, { patientId, startsAt: futureStart(50 + i, 14) });
    await rebasePendingOutbox(app, tenant, taken);
    const now = new Date(taken.getTime() + MINUTE_MS);

    await runDispatcher(app, now, tenant);
    await runDispatcher(app, new Date(now.getTime() + MINUTE_MS), tenant);

    const confirmations = await notificationsOf(app, tenant, { typeCode: 'appointment.confirmed', channel: 'sms' });
    expect(confirmations.filter((r) => r.status === 'sent')).toHaveLength(LIMIT);
    const exhausted = confirmations.filter((r) => r.status === 'suppressed');
    expect(exhausted).toHaveLength(1);
    expect(exhausted[0]).toMatchObject({ suppressionReason: 'quota_exhausted' });
    expect(sandboxOf(app).messages).toHaveLength(LIMIT);
    const fallback = await notificationsOf(app, tenant, { typeCode: 'appointment.confirmed', channel: 'email', subjectId: exhausted[0]?.subjectId });
    expect(fallback).toHaveLength(1);
    expect(fallback[0]).toMatchObject({ status: 'sent' });
    const alerts = await notificationsOf(app, tenant, { typeCode: 'quota.sms_threshold' });
    const byThreshold = (percent: number) => alerts.filter((a) => (a.context as { thresholdPercent: number }).thresholdPercent === percent);
    expect(byThreshold(80).map((a) => a.channel).sort()).toEqual(['email', 'inapp']);
    expect(byThreshold(100).map((a) => a.channel).sort()).toEqual(['email', 'inapp']);
    expect(alerts.every((a) => a.status === 'sent' || a.status === 'delivered')).toBe(true);
    expect(alerts.every((a) => (a.context as { limit: number; month: string }).limit === LIMIT)).toBe(true);
  });

  it('livre l’alerte in-app aux administrateurs, avec un lien interne et sans donnée de santé', async () => {
    const messages = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.inAppMessage.findMany({ where: { typeCode: 'quota.sms_threshold', userId: tenant.adminUserId }, orderBy: { createdAt: 'asc' } }));

    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.title).join('|')).toContain('80 %');
    expect(messages.every((m) => m.link === '/abonnement' && m.readAt === null)).toBe(true);
    expect(JSON.stringify(messages)).not.toContain(PATIENT_EMAIL);
  });

  it('n’émet pas de nouvelle alerte lors d’une passe ultérieure du même mois', async () => {
    const before = await notificationsOf(app, tenant, { typeCode: 'quota.sms_threshold' });

    await runDispatcher(app, new Date(Date.now() + 10 * MINUTE_MS), tenant);

    expect(await notificationsOf(app, tenant, { typeCode: 'quota.sms_threshold' })).toHaveLength(before.length);
  });
});
