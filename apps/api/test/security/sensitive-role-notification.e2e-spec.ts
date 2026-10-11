import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { bearer, http, memoryMailer } from '../auth/auth-helpers';
import { roleIdByCode } from '../iam/support';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { runDispatcher } from '../notifications/dispatch-fixtures';
import { MINUTE_MS, createClockOverrides, notificationsOf } from '../notifications/notification-fixtures';

const TYPE = 'security.sensitive_role_assigned';
const SECRET_SITE = 'Pavillon Secret Nord';

describe('notifications : alerte au Directeur sur les affectations sensibles (docs/11 D10)', () => {
  let app: INestApplication;

  const assign = (token: string, userId: string, roleId: string, scope: { scopeType: string; scopeId?: string } = { scopeType: 'tenant' }) =>
    http(app).post(`/api/v1/iam/users/${userId}/assignments`).set(bearer(token)).send({ roleId, ...scope });
  const sensitiveAudit = (tenant: TenantFixture) =>
    app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.auditLog.findMany({ where: { action: 'iam.role.sensitive_assigned' }, orderBy: { chainSeq: 'asc' } }));
  const dispatch = (tenant: TenantFixture) => runDispatcher(app, new Date(Date.now() + MINUTE_MS), tenant);

  beforeAll(async () => {
    app = await createTestApp({}, { providerOverrides: createClockOverrides().overrides });
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('avec un directeur', () => {
    let tenant: TenantFixture;
    let director: UserFixture;
    let target: UserFixture;
    let siteId: string;

    beforeAll(async () => {
      tenant = await createTenantFixture(app, { prefix: 'alert' });
      director = await createUserWithRole(app, tenant, 'director');
      target = await createUserWithRole(app, tenant, 'receptionist');
      const site = await http(app).post('/api/v1/org/sites').set(bearer(tenant.adminToken)).send({ code: 'MATN', name: SECRET_SITE });
      if (site.status !== 201) throw new Error(JSON.stringify(site.body));
      siteId = site.body.data.id;
    });

    it('notifie le directeur par e-mail et in-app (hors acteur et cible), sans nom de service', async () => {
      const doctorRole = await roleIdByCode(app, tenant, 'doctor');

      await assign(tenant.adminToken, target.userId, doctorRole, { scopeType: 'site', scopeId: siteId }).expect(201);
      await dispatch(tenant);

      const rows = await notificationsOf(app, tenant, { typeCode: TYPE });
      expect(rows.map((r) => `${r.recipientId}:${r.channel}`).sort()).toEqual([`${director.userId}:email`, `${director.userId}:inapp`].sort());
      expect(rows.every((r) => r.status === 'sent' || r.status === 'delivered')).toBe(true);
      expect(rows[0]!.subjectType).toBe('user_role_assignment');
      expect(JSON.stringify(rows.map((r) => r.context))).not.toContain(SECRET_SITE);
      expect(rows[0]!.context).toMatchObject({ targetUserId: target.userId, targetName: 'Utilisateur receptionist', roleName: expect.any(String), scopeType: 'site', actorName: 'Admin Test' });
      const mail = memoryMailer(app).lastTo(director.email)!;
      expect(mail.text).toContain('Utilisateur receptionist');
      expect(mail.text).toContain('un site');
      expect(mail.text).toContain(`/administration/utilisateurs/${target.userId}`);
      expect(`${mail.subject}${mail.text}${mail.html ?? ''}`).not.toContain(SECRET_SITE);
      const inapp = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.inAppMessage.findMany({ where: { userId: director.userId, typeCode: TYPE } }));
      expect(inapp).toHaveLength(1);
      expect(inapp[0]!.link).toBe(`/administration/utilisateurs/${target.userId}`);
      expect(`${inapp[0]!.title}${inapp[0]!.body}`).not.toContain(SECRET_SITE);
      expect(rows.some((r) => r.recipientId === tenant.adminUserId || r.recipientId === target.userId)).toBe(false);
    });

    it('consigne notifiedCount dans l’audit de l’affectation', async () => {
      const audits = await sensitiveAudit(tenant);

      expect(audits.at(-1)!.changes).toMatchObject({ notifiedCount: 1, userId: target.userId });
    });

    it('envoie malgré une préférence « e-mail administratif » désactivée', async () => {
      const other = await createUserWithRole(app, tenant, 'receptionist');
      await app.get(TenantDb).runAs(tenant.tenantId, (tx) =>
        tx.notificationPreference.create({ data: { tenantId: tenant.tenantId, userId: director.userId, category: 'administrative', channel: 'email', enabled: false } }),
      );
      memoryMailer(app).clear();

      await assign(tenant.adminToken, other.userId, await roleIdByCode(app, tenant, 'nurse')).expect(201);
      await dispatch(tenant);

      const emails = (await notificationsOf(app, tenant, { typeCode: TYPE, channel: 'email', subjectType: 'user_role_assignment' })).filter((r) => (r.context as { targetUserId: string }).targetUserId === other.userId);
      expect(emails).toHaveLength(1);
      expect(emails[0]!.status).toBe('sent');
      expect(memoryMailer(app).lastTo(director.email)).toBeDefined();
    });

    it('ne notifie pas pour un rôle non sensible', async () => {
      const before = await notificationsOf(app, tenant, { typeCode: TYPE });
      const plain = await createUserWithRole(app, tenant, 'cashier');

      // Le réceptionniste porte `inpatient:admission:*` (décision 19) : sensible depuis H5. Le RH ne l'est pas.
      await assign(tenant.adminToken, plain.userId, await roleIdByCode(app, tenant, 'hr_manager')).expect(201);

      expect(await notificationsOf(app, tenant, { typeCode: TYPE })).toHaveLength(before.length);
    });

    it('n’écrit pas deux fois la même alerte (clé de déduplication par affectation)', async () => {
      const rows = await notificationsOf(app, tenant, { typeCode: TYPE });
      const keys = rows.map((r) => r.dedupKey);

      expect(new Set(keys).size).toBe(keys.length);
    });
  });

  describe('sans directeur', () => {
    it('notifie l’administrateur principal quand l’acteur est un autre administrateur', async () => {
      const tenant = await createTenantFixture(app, { prefix: 'alert-owner' });
      const admin2 = await createUserWithRole(app, tenant, 'tenant_admin');
      const target = await createUserWithRole(app, tenant, 'receptionist');

      await assign(admin2.token, target.userId, await roleIdByCode(app, tenant, 'doctor')).expect(201);
      await dispatch(tenant);

      const rows = await notificationsOf(app, tenant, { typeCode: TYPE });
      expect(new Set(rows.map((r) => r.recipientId))).toEqual(new Set([tenant.adminUserId]));
      expect(rows.map((r) => r.channel).sort()).toEqual(['email', 'inapp']);
      expect((await sensitiveAudit(tenant)).at(-1)!.changes).toMatchObject({ notifiedCount: 1 });
    });

    it('ne notifie personne quand l’acteur est le principal : l’audit reste la trace (notifiedCount 0)', async () => {
      const tenant = await createTenantFixture(app, { prefix: 'alert-none' });
      const target = await createUserWithRole(app, tenant, 'receptionist');

      await assign(tenant.adminToken, target.userId, await roleIdByCode(app, tenant, 'doctor')).expect(201);

      expect(await notificationsOf(app, tenant, { typeCode: TYPE })).toHaveLength(0);
      expect((await sensitiveAudit(tenant)).at(-1)!.changes).toMatchObject({ notifiedCount: 0 });
    });

    it('n’alerte pas le principal quand il est la cible de l’affectation', async () => {
      const tenant = await createTenantFixture(app, { prefix: 'alert-target' });
      const admin2 = await createUserWithRole(app, tenant, 'tenant_admin');

      await assign(admin2.token, tenant.adminUserId, await roleIdByCode(app, tenant, 'doctor')).expect(403);
      expect(await notificationsOf(app, tenant, { typeCode: TYPE })).toHaveLength(0);
    });
  });
});
