import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { API, bearer, createClockOverrides, http, seedNotification } from './notification-fixtures';

describe('paramètres de notification de l’établissement', () => {
  let app: INestApplication;
  let a: TenantFixture;
  let b: TenantFixture;
  let director: UserFixture;
  let receptionist: UserFixture;

  beforeAll(async () => {
    app = await createTestApp({}, { providerOverrides: createClockOverrides().overrides });
    [a, b] = await Promise.all([createTenantFixture(app, { prefix: 'settings-a' }), createTenantFixture(app, { prefix: 'settings-b' })]);
    director = await createUserWithRole(app, a, 'director');
    receptionist = await createUserWithRole(app, a, 'receptionist');
  });

  afterAll(async () => {
    await app?.close();
  });

  const get = (token: string) => http(app).get(`${API}/notifications/settings`).set(bearer(token));
  const put = (token: string, body: unknown) => http(app).put(`${API}/notifications/settings`).set(bearer(token)).send(body as object);

  it('retourne les valeurs par défaut du contrat quand rien n’est réglé', async () => {
    const res = await get(b.adminToken).expect(200);

    expect(res.body.data).toEqual({
      quietHoursStart: '21:00',
      quietHoursEnd: '07:00',
      smsTransliterate: true,
      senderDisplayName: null,
      appointmentSmsEnabled: true,
      reminderD1Enabled: true,
      reminderD1LocalTime: '10:00',
      reminderH2Enabled: true,
      smsProvider: 'sandbox',
      smsUsage: { month: new Date().toISOString().slice(0, 7), usedSegments: 0, limit: 20_000 },
      updatedAt: null,
    });
  });

  it('refuse sans authentification (401) et sans permission (403), la lecture étant ouverte au directeur', async () => {
    await http(app).get(`${API}/notifications/settings`).expect(401);
    await get(receptionist.token).expect(403);
    await put(receptionist.token, { smsTransliterate: false }).expect(403);
    await get(director.token).expect(200);
    await put(director.token, { smsTransliterate: false }).expect(403);
  });

  it('modifie partiellement les réglages, audite les champs modifiés et conserve le reste', async () => {
    const res = await put(a.adminToken, { quietHoursStart: '20:30', senderDisplayName: 'Clinique Awa', reminderH2Enabled: false }).expect(200);

    expect(res.body.data).toMatchObject({ quietHoursStart: '20:30', quietHoursEnd: '07:00', senderDisplayName: 'Clinique Awa', reminderH2Enabled: false, reminderD1Enabled: true });
    expect(res.body.data.updatedAt).toEqual(expect.any(String));
    expect((await get(a.adminToken)).body.data.quietHoursStart).toBe('20:30');
    const audit = await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.auditLog.findFirstOrThrow({ where: { action: 'notification.settings_updated' }, orderBy: { chainSeq: 'desc' } }));
    expect(audit.changes).toEqual({ quietHoursStart: '20:30', senderDisplayName: 'Clinique Awa', reminderH2Enabled: false });
  });

  it('autorise à effacer le nom d’expéditeur (null)', async () => {
    await put(a.adminToken, { senderDisplayName: 'Clinique Awa' }).expect(200);

    const res = await put(a.adminToken, { senderDisplayName: null }).expect(200);

    expect(res.body.data.senderDisplayName).toBeNull();
  });

  it('refuse une plage silencieuse dont le début égale la fin (422 invalid_quiet_hours), y compris après fusion', async () => {
    const same = await put(a.adminToken, { quietHoursStart: '08:00', quietHoursEnd: '08:00' }).expect(422);
    await put(a.adminToken, { quietHoursStart: '22:00', quietHoursEnd: '06:00' }).expect(200);
    const merged = await put(a.adminToken, { quietHoursEnd: '22:00' }).expect(422);

    expect(same.body.code).toBe('invalid_quiet_hours');
    expect(merged.body.code).toBe('invalid_quiet_hours');
  });

  it('valide le corps (422) : vide, heure invalide, nom trop court ou trop long', async () => {
    for (const body of [{}, { quietHoursStart: '25:00' }, { reminderD1LocalTime: '9h' }, { senderDisplayName: 'A' }, { senderDisplayName: 'x'.repeat(31) }, { smsTransliterate: 'oui' }]) {
      await put(a.adminToken, body).expect(422);
    }
  });

  it('isole les réglages entre établissements', async () => {
    await put(a.adminToken, { appointmentSmsEnabled: false }).expect(200);

    expect((await get(b.adminToken)).body.data.appointmentSmsEnabled).toBe(true);
  });

  it('expose le fournisseur actif et l’usage SMS du mois (segments envoyés) avec la limite du plan', async () => {
    const tenant = await createTenantFixture(app, { prefix: 'settings-usage', subscriptionPlan: 'basic' });
    await seedNotification(app, tenant, { status: 'sent' });
    await app.get(TenantDb).runAs(tenant.tenantId, (tx) =>
      tx.notification.updateMany({ data: { segments: 2, sentAt: new Date() } }),
    );

    const res = await get(tenant.adminToken).expect(200);

    expect(res.body.data.smsProvider).toBe('sandbox');
    expect(res.body.data.smsUsage).toEqual({ month: new Date().toISOString().slice(0, 7), usedSegments: 2, limit: 200 });
  });
});
