import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { TenantDb, type TenantTx } from '../../src/infrastructure/prisma/tenant-db.service';
import { uuidv7 } from '../../src/modules/notifications/domain/uuid-v7';
import { createTenantFixture, type TenantFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { DAY_MS, createPatientWithContacts, seedNotification } from './notification-fixtures';

const UNIQUE_VIOLATION = /unique|duplicate|23505/i;
const CHECK_VIOLATION = /check|23514|violates/i;
const DENIED = /append-only|immuable|interdite|42501|permission/i;

describe('migration 20261005000400_notifications', () => {
  let app: INestApplication;
  let a: TenantFixture;
  let b: TenantFixture;
  let patientId: string;

  beforeAll(async () => {
    app = await createTestApp();
    [a, b] = await Promise.all([createTenantFixture(app, { prefix: 'mig-a' }), createTenantFixture(app, { prefix: 'mig-b' })]);
    patientId = await createPatientWithContacts(app, a);
  });

  afterAll(async () => {
    await app?.close();
  });

  const inTenant = <T>(tenant: Pick<TenantFixture, 'tenantId'>, fn: (tx: TenantTx) => Promise<T>): Promise<T> => app.get(TenantDb).runAs(tenant.tenantId, fn);

  describe('platform.notification_due_tenants', () => {
    const dueTenants = (limit = 1_000) =>
      app.get(TenantDb).runWithoutTenant((tx) => tx.$queryRaw<Record<string, string>[]>`SELECT * FROM platform.notification_due_tenants(${limit}::int)`);
    const dueIds = async (): Promise<string[]> => (await dueTenants()).map((row) => Object.values(row)[0] as string);

    it('renvoie un établissement ayant un événement d’outbox dû, avec le seul identifiant (aucune autre colonne)', async () => {
      const tenant = await createTenantFixture(app, { prefix: 'mig-due' });
      expect(await dueIds()).not.toContain(tenant.tenantId);

      await inTenant(tenant, (tx) =>
        tx.notificationOutboxEvent.create({ data: { tenantId: tenant.tenantId, eventType: 'appointment.created', aggregateType: 'appointment', aggregateId: uuidv7(), payload: {}, availableAt: new Date(Date.now() - 1_000) } }),
      );

      const mine = (await dueTenants()).filter((row) => Object.values(row)[0] === tenant.tenantId);
      expect(mine).toHaveLength(1);
      expect(Object.keys(mine[0] as object)).toEqual(['notification_due_tenants']);
    });

    it('ignore un événement dont l’heure n’est pas venue et rend un établissement dû pour une notification en file', async () => {
      const future = await createTenantFixture(app, { prefix: 'mig-future' });
      await inTenant(future, (tx) =>
        tx.notificationOutboxEvent.create({ data: { tenantId: future.tenantId, eventType: 'appointment.created', aggregateType: 'appointment', aggregateId: uuidv7(), payload: {}, availableAt: new Date(Date.now() + DAY_MS) } }),
      );
      const queued = await createTenantFixture(app, { prefix: 'mig-queued' });
      await seedNotification(app, queued, { status: 'queued', createdAt: new Date(Date.now() - 1_000) });

      const ids = await dueIds();

      expect(ids).not.toContain(future.tenantId);
      expect(ids).toContain(queued.tenantId);
    });

    it('ne rend pas un établissement dont la notification est sous bail, mais le rend dès que le bail expire', async () => {
      const tenant = await createTenantFixture(app, { prefix: 'mig-lease' });
      const row = await seedNotification(app, tenant, { status: 'queued', createdAt: new Date(Date.now() - 5_000) });
      const lock = (lockedUntil: Date) => inTenant(tenant, (tx) => tx.notification.update({ where: { tenantId_id: { tenantId: tenant.tenantId, id: row.id } }, data: { lockedUntil } }));
      await lock(new Date(Date.now() + 60_000));
      expect(await dueIds()).not.toContain(tenant.tenantId);

      await lock(new Date(Date.now() - 1_000));

      expect(await dueIds()).toContain(tenant.tenantId);
    });

    it('respecte la limite demandée et restaure le contexte de l’appelant', async () => {
      const rows = await dueTenants(1);
      const context = await inTenant(a, async (tx) => {
        await tx.$queryRaw`SELECT * FROM platform.notification_due_tenants(5)`;
        return tx.$queryRaw<{ ctx: string }[]>`SELECT current_setting('app.tenant_id', true) AS ctx`;
      });

      expect(rows.length).toBeLessThanOrEqual(1);
      expect(context[0]?.ctx).toBe(a.tenantId);
    });

    it('ignore les établissements résiliés', async () => {
      const tenant = await createTenantFixture(app, { prefix: 'mig-term' });
      await seedNotification(app, tenant, { status: 'queued', createdAt: new Date(Date.now() - 5_000) });
      await app.get(PlatformDb).run((tx) => tx.tenant.update({ where: { id: tenant.tenantId }, data: { status: 'terminated' } }));

      expect(await dueIds()).not.toContain(tenant.tenantId);
    });
  });

  describe('tables en ajout seul', () => {
    it('notification_attempts refuse la modification et la suppression au rôle applicatif', async () => {
      const row = await seedNotification(app, a, { status: 'sent' });
      const attemptId = uuidv7();
      await inTenant(a, (tx) => tx.notificationAttempt.create({ data: { id: attemptId, tenantId: a.tenantId, notificationId: row.id, attempt: 1, outcome: 'sent' } }));

      await expect(inTenant(a, (tx) => tx.$executeRaw`UPDATE tenant.notification_attempts SET outcome = 'failed' WHERE id = ${attemptId}::uuid`)).rejects.toThrow(DENIED);
      await expect(inTenant(a, (tx) => tx.$executeRaw`DELETE FROM tenant.notification_attempts WHERE id = ${attemptId}::uuid`)).rejects.toThrow(DENIED);
      expect(await inTenant(a, (tx) => tx.notificationAttempt.findUnique({ where: { tenantId_id: { tenantId: a.tenantId, id: attemptId } } }))).toMatchObject({ outcome: 'sent' });
    });

    it('patient_contact_consents refuse la modification et la suppression au rôle applicatif', async () => {
      const consent = await inTenant(a, (tx) =>
        tx.patientContactConsent.create({ data: { tenantId: a.tenantId, patientId, channel: 'sms', purpose: 'appointment_reminder', granted: true, source: 'front_desk', recordedBy: a.adminUserId } }),
      );

      await expect(inTenant(a, (tx) => tx.$executeRaw`UPDATE tenant.patient_contact_consents SET granted = false WHERE id = ${consent.id}::uuid`)).rejects.toThrow(DENIED);
      await expect(inTenant(a, (tx) => tx.$executeRaw`DELETE FROM tenant.patient_contact_consents WHERE id = ${consent.id}::uuid`)).rejects.toThrow(DENIED);
    });
  });

  describe('versions de modèles immuables hors is_active', () => {
    const createTemplate = (tenant: TenantFixture, version: number, isActive: boolean) =>
      inTenant(tenant, (tx) => tx.notificationTemplate.create({ data: { tenantId: tenant.tenantId, typeCode: 'appointment.confirmed', channel: 'sms', locale: 'fr', version, body: `v${version}`, isActive } }));

    it('refuse de modifier le corps ou de supprimer une version, autorise is_active', async () => {
      const tenant = await createTenantFixture(app, { prefix: 'mig-tpl' });
      const row = await createTemplate(tenant, 1, true);

      await expect(inTenant(tenant, (tx) => tx.$executeRaw`UPDATE tenant.notification_templates SET body = 'autre' WHERE id = ${row.id}::uuid`)).rejects.toThrow(DENIED);
      await expect(inTenant(tenant, (tx) => tx.$executeRaw`DELETE FROM tenant.notification_templates WHERE id = ${row.id}::uuid`)).rejects.toThrow(DENIED);
      await inTenant(tenant, (tx) => tx.$executeRaw`UPDATE tenant.notification_templates SET is_active = false WHERE id = ${row.id}::uuid`);

      expect(await inTenant(tenant, (tx) => tx.notificationTemplate.findUniqueOrThrow({ where: { tenantId_id: { tenantId: tenant.tenantId, id: row.id } } }))).toMatchObject({ body: 'v1', isActive: false });
    });

    it('n’autorise qu’une seule version active par type, canal et langue', async () => {
      const tenant = await createTenantFixture(app, { prefix: 'mig-tpl2' });
      await createTemplate(tenant, 1, true);

      await expect(createTemplate(tenant, 2, true)).rejects.toThrow(UNIQUE_VIOLATION);
      await expect(createTemplate(tenant, 1, false)).rejects.toThrow(UNIQUE_VIOLATION);
      await createTemplate(tenant, 2, false);
    });
  });

  describe('contraintes', () => {
    it('refuse une notification supprimée sans motif, un in-app destiné à un patient, une clé de déduplication en double', async () => {
      const base = await seedNotification(app, a, { status: 'sent' });

      await expect(inTenant(a, (tx) => tx.$executeRaw`UPDATE tenant.notifications SET status = 'suppressed', suppression_reason = NULL WHERE id = ${base.id}::uuid`)).rejects.toThrow(CHECK_VIOLATION);
      await expect(seedNotification(app, a, { channel: 'inapp', recipientType: 'patient' })).rejects.toThrow(CHECK_VIOLATION);
      await expect(inTenant(a, (tx) => tx.notification.create({ data: { ...omitIdentity(base), id: uuidv7() } }))).rejects.toThrow(UNIQUE_VIOLATION);
    });

    it('refuse un consentement sms_stop accordé et un consentement manuel sans auteur', async () => {
      const insert = (granted: boolean, source: string, recordedBy: string | null) =>
        inTenant(a, (tx) => tx.patientContactConsent.create({ data: { tenantId: a.tenantId, patientId, channel: 'sms', purpose: 'appointment_reminder', granted, source, recordedBy } }));

      await expect(insert(true, 'sms_stop', null)).rejects.toThrow(CHECK_VIOLATION);
      await expect(insert(true, 'front_desk', null)).rejects.toThrow(CHECK_VIOLATION);
      await expect(insert(true, 'source_inconnue', a.adminUserId)).rejects.toThrow(CHECK_VIOLATION);
      await insert(false, 'sms_stop', null);
    });

    it('refuse une plage silencieuse nulle, un lien in-app externe et un statut d’outbox inconnu', async () => {
      await expect(inTenant(a, (tx) => tx.$executeRaw`INSERT INTO tenant.notification_settings (tenant_id, quiet_hours_start, quiet_hours_end) VALUES (${a.tenantId}::uuid, '08:00', '08:00')`)).rejects.toThrow(CHECK_VIOLATION);
      await expect(
        inTenant(a, (tx) => tx.inAppMessage.create({ data: { id: uuidv7(), tenantId: a.tenantId, userId: a.adminUserId, typeCode: 'quota.sms_threshold', title: 't', body: 'b', link: 'https://exemple.com', expiresAt: new Date(Date.now() + DAY_MS) } })),
      ).rejects.toThrow(CHECK_VIOLATION);
      await expect(
        inTenant(a, (tx) => tx.notificationOutboxEvent.create({ data: { tenantId: a.tenantId, eventType: 'appointment.created', aggregateType: 'appointment', aggregateId: uuidv7(), payload: {}, status: 'bizarre' } })),
      ).rejects.toThrow(CHECK_VIOLATION);
    });
  });

  describe('isolation par établissement (RLS)', () => {
    it('masque les lignes d’un autre établissement et refuse d’écrire pour lui', async () => {
      const mine = await seedNotification(app, a, { status: 'sent' });

      expect(await inTenant(b, (tx) => tx.notification.findUnique({ where: { tenantId_id: { tenantId: a.tenantId, id: mine.id } } }))).toBeNull();
      await expect(inTenant(b, (tx) => tx.notification.create({ data: { ...omitIdentity(mine), id: uuidv7(), tenantId: a.tenantId, dedupKey: 'f'.repeat(64) } }))).rejects.toThrow();
    });

    it('rend platform.sms_recipient_tenants inaccessible au rôle applicatif', async () => {
      await expect(inTenant(a, (tx) => tx.$queryRaw`SELECT count(*) FROM platform.sms_recipient_tenants`)).rejects.toThrow(/permission|42501/i);
    });
  });
});

function omitIdentity<T extends { id: string; createdAt: Date }>(row: T): Omit<T, 'id' | 'createdAt'> {
  const { id: _id, createdAt: _createdAt, ...rest } = row;
  return rest;
}
