import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { NotificationsRepository } from '../../src/modules/notifications/repositories/notifications.repository';
import { uuidv7 } from '../../src/modules/notifications/domain/uuid-v7';
import { dedupKey } from '../../src/modules/notifications/domain/dedup-key';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { runDispatcher } from './dispatch-fixtures';
import { API, DAY_MS, HOUR_MS, bearer, createClockOverrides, http, notificationsOf } from './notification-fixtures';

describe('boîte in-app et préférences personnelles', () => {
  let app: INestApplication;
  let a: TenantFixture;
  let b: TenantFixture;
  let admin: { token: string; userId: string };
  let colleague: UserFixture;
  let otherTenantAdmin: { token: string; userId: string };

  beforeAll(async () => {
    app = await createTestApp({}, { providerOverrides: createClockOverrides().overrides });
    [a, b] = await Promise.all([createTenantFixture(app, { prefix: 'inbox-a' }), createTenantFixture(app, { prefix: 'inbox-b' })]);
    admin = { token: a.adminToken, userId: a.adminUserId };
    otherTenantAdmin = { token: b.adminToken, userId: b.adminUserId };
    colleague = await createUserWithRole(app, a, 'receptionist');
  });

  afterAll(async () => {
    await app?.close();
  });

  async function seed(tenant: TenantFixture, userId: string, count: number, overrides: { readAt?: Date; expiresAt?: Date; typeCode?: string; link?: string | null } = {}): Promise<string[]> {
    const ids: string[] = [];
    await app.get(TenantDb).runAs(tenant.tenantId, async (tx) => {
      for (let i = 0; i < count; i += 1) {
        const id = uuidv7();
        ids.push(id);
        await tx.inAppMessage.create({
          data: {
            id,
            tenantId: tenant.tenantId,
            userId,
            typeCode: overrides.typeCode ?? 'quota.sms_threshold',
            title: `Titre ${i}`,
            body: `Corps ${i}`,
            link: overrides.link === undefined ? '/abonnement' : overrides.link,
            expiresAt: overrides.expiresAt ?? new Date(Date.now() + 30 * DAY_MS),
            readAt: overrides.readAt ?? null,
          },
        });
      }
    });
    return ids;
  }

  const get = (path: string, token: string) => http(app).get(`${API}${path}`).set(bearer(token));
  const post = (path: string, token: string) => http(app).post(`${API}${path}`).set(bearer(token));

  describe('GET /notifications/inbox', () => {
    it('refuse une requête sans authentification (401)', async () => {
      await http(app).get(`${API}/notifications/inbox`).expect(401);
    });

    it('liste les messages de l’utilisateur, du plus récent au plus ancien, sans ceux des autres ni les expirés', async () => {
      const user = await createUserWithRole(app, a, 'receptionist');
      const mine = await seed(a, user.userId, 3);
      await seed(a, user.userId, 1, { expiresAt: new Date(Date.now() - HOUR_MS) });
      await seed(a, colleague.userId, 2);
      await seed(b, otherTenantAdmin.userId, 2);

      const res = await get('/notifications/inbox', user.token).expect(200);

      expect(res.body.data.map((m: { id: string }) => m.id)).toEqual([...mine].reverse());
      expect(res.body.data[0]).toEqual({
        id: mine[2],
        typeCode: 'quota.sms_threshold',
        title: 'Titre 2',
        body: 'Corps 2',
        link: '/abonnement',
        createdAt: expect.any(String),
        readAt: null,
      });
      expect(JSON.stringify(res.body)).not.toContain('userId');
    });

    it('filtre les non lus et pagine par curseur', async () => {
      const user = await createUserWithRole(app, a, 'receptionist');
      const unread = await seed(a, user.userId, 3);
      await seed(a, user.userId, 2, { readAt: new Date() });

      const onlyUnread = await get('/notifications/inbox?unreadOnly=true', user.token).expect(200);
      expect(onlyUnread.body.data.map((m: { id: string }) => m.id)).toEqual([...unread].reverse());

      const first = await get('/notifications/inbox?limit=2', user.token).expect(200);
      expect(first.body.data).toHaveLength(2);
      expect(first.body.meta.pagination).toMatchObject({ hasMore: true, limit: 2 });
      const second = await get(`/notifications/inbox?limit=2&cursor=${first.body.meta.pagination.nextCursor}`, user.token).expect(200);
      expect(second.body.data).toHaveLength(2);
      expect(second.body.data[0].id < first.body.data[1].id).toBe(true);
    });

    it('refuse un curseur invalide (422) et une limite hors bornes (422)', async () => {
      const bad = await get('/notifications/inbox?cursor=pas-un-curseur', admin.token).expect(422);
      expect(bad.body.errors[0].path).toBe('cursor');
      await get('/notifications/inbox?limit=51', admin.token).expect(422);
      await get('/notifications/inbox?limit=0', admin.token).expect(422);
    });
  });

  describe('GET /notifications/inbox/unread-count', () => {
    it('compte les messages non lus non expirés', async () => {
      const user = await createUserWithRole(app, a, 'receptionist');
      await seed(a, user.userId, 3);
      await seed(a, user.userId, 2, { readAt: new Date() });
      await seed(a, user.userId, 1, { expiresAt: new Date(Date.now() - HOUR_MS) });

      const res = await get('/notifications/inbox/unread-count', user.token).expect(200);

      expect(res.body.data).toEqual({ count: 3, capped: false });
    });

    it('plafonne le compteur à 999', async () => {
      const user = await createUserWithRole(app, a, 'receptionist');
      await seed(a, user.userId, 1_001);

      const res = await get('/notifications/inbox/unread-count', user.token).expect(200);

      expect(res.body.data).toEqual({ count: 999, capped: true });
    }, 60_000);
  });

  describe('POST /notifications/inbox/{id}/read', () => {
    it('marque un message lu (200) et reste idempotent', async () => {
      const user = await createUserWithRole(app, a, 'receptionist');
      const [id] = await seed(a, user.userId, 1);

      const first = await post(`/notifications/inbox/${id}/read`, user.token).expect(200);
      const second = await post(`/notifications/inbox/${id}/read`, user.token).expect(200);

      expect(first.body.data.readAt).toEqual(expect.any(String));
      expect(second.body.data.readAt).toBe(first.body.data.readAt);
      expect((await get('/notifications/inbox/unread-count', user.token)).body.data.count).toBe(0);
    });

    it('répond 404 pour un message d’un autre utilisateur, d’un autre établissement, expiré, inconnu ou mal formé', async () => {
      const [foreign] = await seed(a, colleague.userId, 1);
      const [otherTenant] = await seed(b, otherTenantAdmin.userId, 1);
      const [expired] = await seed(a, admin.userId, 1, { expiresAt: new Date(Date.now() - HOUR_MS) });

      for (const id of [foreign, otherTenant, expired, uuidv7(), 'pas-un-uuid']) {
        await post(`/notifications/inbox/${id}/read`, admin.token).expect(404);
      }
    });
  });

  describe('POST /notifications/inbox/read-all', () => {
    it('marque tous les messages de l’utilisateur lus sans toucher aux autres', async () => {
      const user = await createUserWithRole(app, a, 'receptionist');
      await seed(a, user.userId, 3);
      await seed(a, colleague.userId, 2);
      const colleagueBefore = (await get('/notifications/inbox/unread-count', colleague.token)).body.data.count;

      const first = await post('/notifications/inbox/read-all', user.token).expect(200);
      const second = await post('/notifications/inbox/read-all', user.token).expect(200);

      expect(first.body.data).toEqual({ updated: 3 });
      expect(second.body.data).toEqual({ updated: 0 });
      expect((await get('/notifications/inbox/unread-count', colleague.token)).body.data.count).toBe(colleagueBefore);
    });
  });

  describe('préférences personnelles', () => {
    it('expose administrative/inapp verrouillée et administrative/email modifiable avec sa note', async () => {
      const user = await createUserWithRole(app, a, 'receptionist');

      const res = await get('/notifications/preferences', user.token).expect(200);

      expect(res.body.data.items).toEqual([
        { category: 'administrative', channel: 'email', enabled: true, locked: false, note: expect.stringContaining('facturation') },
        { category: 'administrative', channel: 'inapp', enabled: true, locked: true, note: null },
      ]);
    });

    it('désactive l’e-mail administratif, journalise la modification, par utilisateur', async () => {
      const user = await createUserWithRole(app, a, 'receptionist');

      const res = await http(app)
        .put(`${API}/notifications/preferences`)
        .set(bearer(user.token))
        .send({ items: [{ category: 'administrative', channel: 'email', enabled: false }] })
        .expect(200);

      expect(res.body.data.items[0]).toMatchObject({ channel: 'email', enabled: false, locked: false });
      expect((await get('/notifications/preferences', colleague.token)).body.data.items[0].enabled).toBe(true);
      expect((await get('/notifications/preferences', user.token)).body.data.items[0].enabled).toBe(false);
      const audit = await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.auditLog.findFirst({ where: { action: 'notification.preferences_updated', actorUserId: user.userId } }));
      expect(audit?.changes).toEqual({ items: [{ category: 'administrative', channel: 'email', enabled: false }] });
    });

    it('refuse de désactiver administrative/inapp (422 preference_locked, items.N)', async () => {
      const user = await createUserWithRole(app, a, 'receptionist');

      const res = await http(app)
        .put(`${API}/notifications/preferences`)
        .set(bearer(user.token))
        .send({
          items: [
            { category: 'administrative', channel: 'email', enabled: false },
            { category: 'administrative', channel: 'inapp', enabled: false },
          ],
        })
        .expect(422);

      expect(res.body.code).toBe('preference_locked');
      expect(res.body.errors).toEqual([expect.objectContaining({ path: 'items.1', code: 'preference_locked' })]);
      expect((await get('/notifications/preferences', user.token)).body.data.items[0].enabled).toBe(true);
    });

    it('valide le corps (422) et exige l’authentification (401)', async () => {
      await http(app).put(`${API}/notifications/preferences`).set(bearer(admin.token)).send({ items: [] }).expect(422);
      await http(app).put(`${API}/notifications/preferences`).set(bearer(admin.token)).send({ items: [{ category: 'transactional', channel: 'email', enabled: false }] }).expect(422);
      await http(app).put(`${API}/notifications/preferences`).send({ items: [] }).expect(401);
    });
  });

  describe('effet des préférences à l’envoi', () => {
    async function queueEmail(userId: string, typeCode: string, context: Record<string, unknown>): Promise<string> {
      const now = new Date();
      await app.get(TenantDb).runAs(a.tenantId, (tx) =>
        app.get(NotificationsRepository).insert(
          tx,
          a.tenantId,
          {
            typeCode,
            category: 'administrative',
            channel: 'email',
            recipientType: 'user',
            recipientId: userId,
            subjectType: null,
            subjectId: null,
            subjectVersion: null,
            sourceEventId: null,
            dedupKey: dedupKey({ tenantId: a.tenantId, sourceKey: uuidv7(), typeCode, recipientType: 'user', recipientId: userId, channel: 'email' }),
            locale: 'fr',
            context,
            suppressionReason: null,
            scheduledAt: now,
            deadlineAt: null,
          },
          now,
        ),
      );
      return typeCode;
    }

    it('un e-mail désactivé est supprimé (preference_disabled), sauf pour les relances d’abonnement', async () => {
      const user = await createUserWithRole(app, a, 'receptionist');
      await http(app).put(`${API}/notifications/preferences`).set(bearer(user.token)).send({ items: [{ category: 'administrative', channel: 'email', enabled: false }] }).expect(200);
      await queueEmail(user.userId, 'quota.sms_threshold', { month: '2026-10', thresholdPercent: 80, limit: 100 });
      await queueEmail(user.userId, 'subscription.payment_reminder', { invoiceNumber: 'F-1', amount: '1000.00', currency: 'XOF', dueAt: new Date().toISOString(), offsetDays: 0 });

      await runDispatcher(app, new Date(Date.now() + 60_000), a);

      const rows = await notificationsOf(app, a, { recipientId: user.userId, channel: 'email' });
      const quota = rows.find((r) => r.typeCode === 'quota.sms_threshold');
      const billing = rows.find((r) => r.typeCode === 'subscription.payment_reminder');
      expect(quota).toMatchObject({ status: 'suppressed', suppressionReason: 'preference_disabled' });
      expect(billing).toMatchObject({ status: 'sent' });
    });
  });
});
