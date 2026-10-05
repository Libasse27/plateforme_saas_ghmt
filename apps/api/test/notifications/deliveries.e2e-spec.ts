import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { API, DAY_MS, HOUR_MS, bearer, createClockOverrides, http, seedNotification } from './notification-fixtures';

describe('journal des envois', () => {
  let app: INestApplication;
  let a: TenantFixture;
  let b: TenantFixture;
  let director: UserFixture;
  let receptionist: UserFixture;
  const patientId = '0197a3c0-0000-7000-8000-00000000cafe';

  const now = Date.now();
  const ago = (ms: number): Date => new Date(now - ms);

  beforeAll(async () => {
    app = await createTestApp({}, { providerOverrides: createClockOverrides().overrides });
    [a, b] = await Promise.all([createTenantFixture(app, { prefix: 'log-a' }), createTenantFixture(app, { prefix: 'log-b' })]);
    director = await createUserWithRole(app, a, 'director');
    receptionist = await createUserWithRole(app, a, 'receptionist');
    await seedNotification(app, a, { createdAt: ago(HOUR_MS), recipientId: patientId, status: 'sent' });
    await seedNotification(app, a, { createdAt: ago(2 * HOUR_MS), recipientId: patientId, status: 'failed', channel: 'email', recipientMasked: 'a***@e***.sn' });
    await seedNotification(app, a, { createdAt: ago(3 * HOUR_MS), recipientId: patientId, status: 'suppressed', suppressionReason: 'no_consent', typeCode: 'appointment.reminder_d1' });
    await seedNotification(app, a, { createdAt: ago(10 * DAY_MS), status: 'sent' });
    await seedNotification(app, a, { createdAt: ago(20 * DAY_MS), status: 'sent' });
    await seedNotification(app, b, { createdAt: ago(HOUR_MS), status: 'sent' });
  });

  afterAll(async () => {
    await app?.close();
  });

  const list = (token: string, query = '') => http(app).get(`${API}/notifications/deliveries${query}`).set(bearer(token));

  it('exige l’authentification (401) et settings:notification_log:read (403) ; le directeur peut lire', async () => {
    await http(app).get(`${API}/notifications/deliveries`).expect(401);
    await list(receptionist.token).expect(403);
    await list(director.token).expect(200);
  });

  it('liste par défaut les 7 derniers jours, du plus récent au plus ancien, avec la vue du contrat', async () => {
    const res = await list(a.adminToken).expect(200);

    expect(res.body.data).toHaveLength(3);
    expect(res.body.data[0]).toEqual({
      id: expect.any(String),
      typeCode: 'appointment.confirmed',
      channel: 'sms',
      status: 'sent',
      suppressionReason: null,
      recipientType: 'patient',
      recipientMasked: '+22177*****45',
      subjectType: null,
      subjectId: null,
      attempts: 0,
      errorClass: null,
      errorCode: null,
      provider: null,
      createdAt: expect.any(String),
      scheduledAt: expect.any(String),
      sentAt: null,
      deliveredAt: null,
    });
    const times = res.body.data.map((row: { createdAt: string }) => row.createdAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('n’expose jamais l’identifiant d’un patient, ni de texte ou de clair', async () => {
    const res = await list(a.adminToken, '?limit=100').expect(200);
    const dump = JSON.stringify(res.body);

    expect(dump).not.toContain(patientId);
    expect(dump).not.toContain('recipientId');
    expect(dump).not.toContain('recipientHash');
    expect(dump).not.toContain('dedup');
  });

  it('filtre par statut, canal et type', async () => {
    expect((await list(a.adminToken, '?status=failed')).body.data.map((r: { status: string }) => r.status)).toEqual(['failed']);
    expect((await list(a.adminToken, '?channel=email')).body.data).toHaveLength(1);
    const reminder = await list(a.adminToken, '?typeCode=appointment.reminder_d1');
    expect(reminder.body.data).toEqual([expect.objectContaining({ status: 'suppressed', suppressionReason: 'no_consent' })]);
  });

  it('étend la fenêtre avec from et to (31 jours au plus)', async () => {
    const from = new Date(now - 15 * DAY_MS).toISOString();
    const res = await list(a.adminToken, `?from=${encodeURIComponent(from)}&limit=100`).expect(200);

    expect(res.body.data).toHaveLength(4);
    const wide = new Date(now - 30 * DAY_MS).toISOString();
    expect((await list(a.adminToken, `?from=${encodeURIComponent(wide)}&limit=100`)).body.data).toHaveLength(5);
  });

  it('refuse une plage de plus de 31 jours (422 range_too_large) et une plage inversée (422)', async () => {
    const from = new Date(now - 40 * DAY_MS).toISOString();
    const to = new Date(now).toISOString();

    const tooLarge = await list(a.adminToken, `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`).expect(422);
    await list(a.adminToken, `?from=${encodeURIComponent(to)}&to=${encodeURIComponent(from)}`).expect(422);

    expect(tooLarge.body.code).toBe('range_too_large');
    await list(a.adminToken, `?from=${encodeURIComponent(from)}`).expect(422);
  });

  it('pagine par curseur et valide limite et curseur', async () => {
    const first = await list(a.adminToken, '?limit=2').expect(200);
    const second = await list(a.adminToken, `?limit=2&cursor=${first.body.meta.pagination.nextCursor}`).expect(200);

    expect(first.body.data).toHaveLength(2);
    expect(first.body.meta.pagination.hasMore).toBe(true);
    expect(second.body.data).toHaveLength(1);
    expect(second.body.meta.pagination.hasMore).toBe(false);
    const ids = [...first.body.data, ...second.body.data].map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(3);
    await list(a.adminToken, '?limit=101').expect(422);
    expect((await list(a.adminToken, '?cursor=invalide').expect(422)).body.errors[0].path).toBe('cursor');
  });

  it('isole les établissements : l’administrateur du tenant B ne voit que ses lignes', async () => {
    const res = await list(b.adminToken).expect(200);

    expect(res.body.data).toHaveLength(1);
  });

  it('audite la lecture avec le nombre de résultats', async () => {
    await list(a.adminToken, '?limit=2').expect(200);

    const audit = await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.auditLog.findFirstOrThrow({ where: { action: 'notification.deliveries_listed' }, orderBy: { chainSeq: 'desc' } }));

    expect(audit.changes).toEqual({ resultCount: 2 });
  });
});
