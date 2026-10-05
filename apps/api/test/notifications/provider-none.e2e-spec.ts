import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MAILER } from '../../src/common/mail/mailer';
import { MemoryMailer } from '../../src/common/mail/memory-mailer';
import { SMS_PROVIDER_TOKEN, UnavailableSmsProvider } from '../../src/modules/notifications/providers/sms-provider';
import { Clock } from '../../src/common/time/clock';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { MutableClock } from '../helpers/mutable-clock';
import { createTestApp } from '../helpers/test-app';
import { runDispatcher } from './dispatch-fixtures';
import { MINUTE_MS, PATIENT_EMAIL, bookAppointment, createPatientWithContacts, findNotification, futureStart, notificationsOf, rebasePendingOutbox, recordConsent, utcAt } from './notification-fixtures';

describe('fournisseur SMS « none » : suppression et repli e-mail', () => {
  let app: INestApplication;
  let tenant: TenantFixture;
  let receptionist: UserFixture;
  let mailer: MemoryMailer;
  let dayOffset = 0;

  beforeAll(async () => {
    app = await createTestApp(
      {},
      { providerOverrides: [{ token: Clock, useValue: new MutableClock() }, { token: SMS_PROVIDER_TOKEN, useValue: new UnavailableSmsProvider() }] },
    );
    tenant = await createTenantFixture(app, { prefix: 'none' });
    receptionist = await createUserWithRole(app, tenant, 'receptionist');
    mailer = app.get(MAILER) as MemoryMailer;
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => mailer.clear());

  async function book(patientId: string): Promise<{ id: string; start: Date; taken: Date }> {
    dayOffset += 1;
    const start = futureStart(40 + dayOffset, 14);
    const taken = utcAt(start, -5, 11);
    const id = await bookAppointment(app, tenant, receptionist, { patientId, startsAt: start });
    await rebasePendingOutbox(app, tenant, taken);
    return { id, start, taken };
  }

  it('supprime le SMS de confirmation (provider_unavailable) et le remplace par un e-mail', async () => {
    const patientId = await createPatientWithContacts(app, tenant);
    const { id, taken } = await book(patientId);

    await runDispatcher(app, new Date(taken.getTime() + MINUTE_MS), tenant);

    const rows = await notificationsOf(app, tenant, { subjectId: id, typeCode: 'appointment.confirmed' });
    expect(rows.map((r) => [r.channel, r.status, r.suppressionReason])).toEqual(expect.arrayContaining([['sms', 'suppressed', 'provider_unavailable'], ['email', 'sent', null]]));
    expect(rows).toHaveLength(2);
    expect(mailer.lastTo(PATIENT_EMAIL)?.subject).toContain('Rendez-vous confirmé');
  });

  it('un rappel ne se replie sur l’e-mail que si le patient a consenti à ce canal', async () => {
    const withoutEmailConsent = await createPatientWithContacts(app, tenant);
    await recordConsent(app, tenant, withoutEmailConsent, 'sms');
    const withEmailConsent = await createPatientWithContacts(app, tenant, { email: 'consenti@exemple.sn' });
    await recordConsent(app, tenant, withEmailConsent, 'sms');
    await recordConsent(app, tenant, withEmailConsent, 'email');
    const a = await book(withoutEmailConsent);
    const b = await book(withEmailConsent);
    await runDispatcher(app, new Date(a.taken.getTime() + MINUTE_MS), tenant);
    mailer.clear();

    await runDispatcher(app, new Date(a.start.getTime() - 2 * 60 * MINUTE_MS + MINUTE_MS), tenant);
    await runDispatcher(app, new Date(b.start.getTime() - 2 * 60 * MINUTE_MS + MINUTE_MS), tenant);

    const aRows = await notificationsOf(app, tenant, { subjectId: a.id, typeCode: 'appointment.reminder_h2' });
    const bRows = await notificationsOf(app, tenant, { subjectId: b.id, typeCode: 'appointment.reminder_h2' });
    expect(aRows.map((r) => [r.channel, r.status, r.suppressionReason])).toEqual([['sms', 'suppressed', 'provider_unavailable']]);
    expect(bRows.map((r) => [r.channel, r.status])).toEqual(expect.arrayContaining([['sms', 'suppressed'], ['email', 'sent']]));
    expect(mailer.lastTo('consenti@exemple.sn')?.subject).toContain('Rappel');
    expect(mailer.lastTo(PATIENT_EMAIL)).toBeUndefined();
  });
});
