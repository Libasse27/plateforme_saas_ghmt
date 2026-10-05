import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { runDispatcher, sandboxOf } from './dispatch-fixtures';
import {
  API,
  MINUTE_MS,
  bearer,
  bookAppointment,
  createClockOverrides,
  createPatientWithContacts,
  findNotification,
  futureStart,
  http,
  rebasePendingOutbox,
  utcAt,
} from './notification-fixtures';

const URL_BASE = `${API}/notifications/templates`;
const GOOD_SMS = '{{etablissement.nom}} : votre rdv du {{rdv.date}} a {{rdv.heure}} est bien enregistre.';

describe('modèles de notification', () => {
  let app: INestApplication;
  let a: TenantFixture;
  let b: TenantFixture;
  let director: UserFixture;
  let receptionist: UserFixture;

  beforeAll(async () => {
    app = await createTestApp({}, { providerOverrides: createClockOverrides().overrides });
    [a, b] = await Promise.all([createTenantFixture(app, { prefix: 'tpl-a' }), createTenantFixture(app, { prefix: 'tpl-b' })]);
    director = await createUserWithRole(app, a, 'director');
    receptionist = await createUserWithRole(app, a, 'receptionist');
    await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.department.create({ data: { tenantId: a.tenantId, siteId: a.mainSiteId, code: 'CARDIO', name: 'Cardiologie' } }));
  });

  afterAll(async () => {
    await app?.close();
  });

  const put = (token: string, path: string, body: unknown) => http(app).put(`${URL_BASE}/${path}`).set(bearer(token)).send(body as object);
  const del = (token: string, path: string) => http(app).delete(`${URL_BASE}/${path}`).set(bearer(token));
  const list = (token: string, query = '') => http(app).get(`${URL_BASE}${query}`).set(bearer(token));
  const preview = (token: string, body: unknown) => http(app).post(`${URL_BASE}/preview`).set(bearer(token)).send(body as object);

  describe('GET /notifications/templates', () => {
    it('retourne le modèle effectif de chaque type × canal × langue (40 modèles par défaut)', async () => {
      const res = await list(b.adminToken).expect(200);

      expect(res.body.data).toHaveLength(40);
      const confirmed = res.body.data.find((t: { typeCode: string; channel: string; locale: string }) => t.typeCode === 'appointment.confirmed' && t.channel === 'sms' && t.locale === 'fr');
      expect(confirmed).toEqual({
        typeCode: 'appointment.confirmed',
        channel: 'sms',
        locale: 'fr',
        source: 'default',
        version: 1,
        subject: null,
        body: expect.stringContaining('{{rdv.date}}'),
        variables: ['etablissement.nom', 'site.nom', 'patient.prenom', 'rdv.date', 'rdv.heure'],
        updatedAt: null,
      });
    });

    it('filtre par type et refuse un type inconnu (422)', async () => {
      const res = await list(b.adminToken, '?typeCode=appointment.confirmed').expect(200);

      expect(res.body.data).toHaveLength(4);
      await list(b.adminToken, '?typeCode=inconnu').expect(422);
    });

    it('exige la permission de lecture (403 réceptionniste, 401 sans jeton) ; le directeur peut lire', async () => {
      await http(app).get(URL_BASE).expect(401);
      await list(receptionist.token).expect(403);
      await list(director.token).expect(200);
    });
  });

  describe('PUT /notifications/templates/{type}/{canal}/{langue}', () => {
    it('crée une surcharge versionnée : version 1, puis 2 ; une seule version active, versions précédentes conservées', async () => {
      const first = await put(a.adminToken, 'appointment.confirmed/sms/fr', { body: GOOD_SMS }).expect(200);
      const second = await put(a.adminToken, 'appointment.confirmed/sms/fr', { body: `${GOOD_SMS} Merci.` }).expect(200);

      expect(first.body.data).toMatchObject({ source: 'custom', version: 1, subject: null, body: GOOD_SMS });
      expect(second.body.data).toMatchObject({ source: 'custom', version: 2 });
      const rows = await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.notificationTemplate.findMany({ where: { typeCode: 'appointment.confirmed', channel: 'sms', locale: 'fr' }, orderBy: { version: 'asc' } }));
      expect(rows.map((r) => [r.version, r.isActive])).toEqual([[1, false], [2, true]]);
      const effective = (await list(a.adminToken, '?typeCode=appointment.confirmed')).body.data.find((t: { channel: string; locale: string }) => t.channel === 'sms' && t.locale === 'fr');
      expect(effective).toMatchObject({ source: 'custom', version: 2, updatedAt: expect.any(String) });
    });

    it('n’affecte pas les autres établissements ni les autres langues', async () => {
      const otherTenant = (await list(b.adminToken, '?typeCode=appointment.confirmed')).body.data.find((t: { channel: string; locale: string }) => t.channel === 'sms' && t.locale === 'fr');
      const english = (await list(a.adminToken, '?typeCode=appointment.confirmed')).body.data.find((t: { channel: string; locale: string }) => t.channel === 'sms' && t.locale === 'en');

      expect(otherTenant.source).toBe('default');
      expect(english.source).toBe('default');
    });

    it('audite sans jamais consigner le texte', async () => {
      await put(a.adminToken, 'appointment.cancelled/sms/fr', { body: '{{etablissement.nom}} : rdv annule le {{rdv.date}}.' }).expect(200);

      const audit = await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.auditLog.findFirstOrThrow({ where: { action: 'notification.template_updated' }, orderBy: { chainSeq: 'desc' } }));

      expect(audit.changes).toEqual({ typeCode: 'appointment.cancelled', channel: 'sms', locale: 'fr', version: 1 });
    });

    it.each([
      ['inconnu/sms/fr'],
      ['appointment.confirmed/push/fr'],
      ['subscription.payment_reminder/sms/fr'],
      ['appointment.confirmed/sms/es'],
    ])('répond 404 template_not_found pour la combinaison absente du catalogue (%s)', async (path) => {
      const res = await put(a.adminToken, path, { body: 'ok' }).expect(404);

      expect(res.body.code).toBe('template_not_found');
    });

    it.each([
      ['unknown_variable', 'appointment.confirmed/sms/fr', { body: 'Bonjour {{patient.nom}}' }],
      ['forbidden_term', 'appointment.confirmed/sms/fr', { body: 'Votre résultat est prêt' }],
      ['service_name', 'appointment.confirmed/sms/fr', { body: 'Rdv au service Cardiologie' }],
      ['too_many_segments', 'appointment.confirmed/sms/fr', { body: 'x'.repeat(461) }],
      ['too_long', 'quota.sms_threshold/inapp/fr', { subject: 'Titre', body: 'x'.repeat(501) }],
      ['subject_required', 'appointment.confirmed/email/fr', { body: 'Bonjour' }],
      ['subject_forbidden', 'appointment.confirmed/sms/fr', { subject: 'Sujet', body: 'ok' }],
    ])('refuse la surcharge avec 422 template_rejected (%s)', async (code, path, body) => {
      const res = await put(a.adminToken, path, body).expect(422);

      expect(res.body.code).toBe('template_rejected');
      expect(res.body.errors).toEqual(expect.arrayContaining([expect.objectContaining({ code })]));
    });

    it('refuse la validation de corps (422) : corps vide, trop long', async () => {
      await put(a.adminToken, 'appointment.confirmed/sms/fr', { body: '' }).expect(422);
      await put(a.adminToken, 'appointment.confirmed/sms/fr', { body: 'x'.repeat(5001) }).expect(422);
    });

    it('exige la permission de modification (403 pour le directeur, 401 sans jeton)', async () => {
      await put(director.token, 'appointment.confirmed/sms/fr', { body: GOOD_SMS }).expect(403);
      await put(receptionist.token, 'appointment.confirmed/sms/fr', { body: GOOD_SMS }).expect(403);
      await http(app).put(`${URL_BASE}/appointment.confirmed/sms/fr`).send({ body: GOOD_SMS }).expect(401);
    });
  });

  describe('DELETE /notifications/templates/{type}/{canal}/{langue}', () => {
    it('réinitialise au modèle par défaut (204) puis répond 404 quand aucune surcharge n’existe', async () => {
      await put(a.adminToken, 'appointment.rescheduled/sms/fr', { body: '{{etablissement.nom}} : rdv deplace au {{rdv.date}}.' }).expect(200);

      await del(a.adminToken, 'appointment.rescheduled/sms/fr').expect(204);
      const second = await del(a.adminToken, 'appointment.rescheduled/sms/fr').expect(404);

      expect(second.body.code).toBe('template_not_found');
      const effective = (await list(a.adminToken, '?typeCode=appointment.rescheduled')).body.data.find((t: { channel: string; locale: string }) => t.channel === 'sms' && t.locale === 'fr');
      expect(effective.source).toBe('default');
      const audit = await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.auditLog.findFirstOrThrow({ where: { action: 'notification.template_reset' }, orderBy: { chainSeq: 'desc' } }));
      expect(audit.changes).toEqual({ typeCode: 'appointment.rescheduled', channel: 'sms', locale: 'fr', version: 1 });
    });

    it('une nouvelle surcharge après réinitialisation reprend la numérotation (version 2)', async () => {
      await put(a.adminToken, 'appointment.reminder_d1/sms/fr', { body: '{{etablissement.nom}} : rappel rdv {{rdv.date}}.' }).expect(200);
      await del(a.adminToken, 'appointment.reminder_d1/sms/fr').expect(204);

      const res = await put(a.adminToken, 'appointment.reminder_d1/sms/fr', { body: '{{etablissement.nom}} : rappel rdv le {{rdv.date}}.' }).expect(200);

      expect(res.body.data.version).toBe(2);
    });

    it('exige la permission de modification', async () => {
      await del(director.token, 'appointment.rescheduled/sms/fr').expect(403);
    });
  });

  describe('POST /notifications/templates/preview', () => {
    const base = { typeCode: 'appointment.confirmed', channel: 'sms', locale: 'fr' };

    it('rend avec des valeurs d’exemple et calcule caractères, segments et encodage', async () => {
      const res = await preview(a.adminToken, { ...base, body: 'RDV le {{rdv.date}} a {{rdv.heure}}' }).expect(200);

      expect(res.body.data).toEqual({ subject: null, body: 'RDV le mercredi 30 septembre a 23:59', characters: 36, segments: 1, encoding: 'GSM7', issues: [] });
    });

    it('répond 200 même si le linter signale des problèmes, qu’il liste', async () => {
      const res = await preview(a.adminToken, { ...base, body: 'Votre résultat {{patient.nom}}' }).expect(200);

      expect(res.body.data.issues.map((i: { code: string }) => i.code).sort()).toEqual(['forbidden_term', 'unknown_variable']);
    });

    it('rend l’objet d’un e-mail et ne calcule pas de segments hors SMS', async () => {
      const res = await preview(a.adminToken, { typeCode: 'appointment.confirmed', channel: 'email', locale: 'en', subject: 'On {{rdv.date}}', body: 'Hello {{patient.prenom}}' }).expect(200);

      expect(res.body.data).toMatchObject({ subject: 'On mercredi 30 septembre', body: 'Hello Marie-Madeleine', segments: null, encoding: null, issues: [] });
    });

    it('valide le corps (422) et un canal absent du type (422)', async () => {
      await preview(a.adminToken, { ...base, typeCode: 'inconnu', body: 'x' }).expect(422);
      await preview(a.adminToken, { ...base, locale: 'es', body: 'x' }).expect(422);
      await preview(a.adminToken, { typeCode: 'subscription.payment_overdue', channel: 'sms', locale: 'fr', body: 'x' }).expect(422);
    });

    it('est ouvert en lecture au directeur et refusé au réceptionniste (403)', async () => {
      await preview(director.token, { ...base, body: 'ok' }).expect(200);
      await preview(receptionist.token, { ...base, body: 'ok' }).expect(403);
    });
  });

  it('une surcharge active est utilisée à l’envoi (source custom et version tracées)', async () => {
    const tenant = await createTenantFixture(app, { prefix: 'tpl-send' });
    const user = await createUserWithRole(app, tenant, 'receptionist');
    await put(tenant.adminToken, 'appointment.confirmed/sms/fr', { body: '{{etablissement.nom}} : votre rdv du {{rdv.date}} est note.' }).expect(200);
    const patient = await createPatientWithContacts(app, tenant);
    const start = futureStart(70, 14);
    const taken = utcAt(start, -5, 11);
    const id = await bookAppointment(app, tenant, user, { patientId: patient, startsAt: start });
    await rebasePendingOutbox(app, tenant, taken);
    sandboxOf(app).clear();

    await runDispatcher(app, new Date(taken.getTime() + MINUTE_MS), tenant);

    expect(sandboxOf(app).messages.at(-1)?.text).toContain('est note.');
    expect(await findNotification(app, tenant, id, 'appointment.confirmed')).toMatchObject({ status: 'sent', templateSource: 'custom', templateVersion: 1 });
  });
});
