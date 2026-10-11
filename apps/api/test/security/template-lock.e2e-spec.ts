import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { SecurityAlertService } from '../../src/modules/notifications/services/security-alert.service';
import { bearer, http, memoryMailer } from '../auth/auth-helpers';
import { createTenantFixture, createUserWithRole, type TenantFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { runDispatcher } from '../notifications/dispatch-fixtures';
import { MINUTE_MS } from '../notifications/notification-fixtures';

const URL_BASE = '/api/v1/notifications/templates';

describe('modèles security.* non personnalisables (décision 23, docs/11 §14.1)', () => {
  let app: INestApplication;
  let tenant: TenantFixture;

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await createTenantFixture(app, { prefix: 'tpl-lock' });
  });

  afterAll(async () => {
    await app?.close();
  });

  it.each(['security.sensitive_role_assigned', 'security.owner_transferred', 'security.login_delay_alert'])('refuse de modifier ou de réinitialiser %s (422 template_locked)', async (typeCode) => {
    const put = await http(app)
      .put(`${URL_BASE}/${typeCode}/email/fr`)
      .set(bearer(tenant.adminToken))
      .send({ subject: 'Alerte', body: 'Bonjour, {{acteur.nom}} a fait une modification : {{lien}}' })
      .expect(422);
    const del = await http(app).delete(`${URL_BASE}/${typeCode}/inapp/fr`).set(bearer(tenant.adminToken)).expect(422);

    expect(put.body.code).toBe('template_locked');
    expect(del.body.code).toBe('template_locked');
  });

  it('les modèles security.* restent listés (modèle par défaut)', async () => {
    const res = await http(app).get(`${URL_BASE}?typeCode=security.policy_changed`).set(bearer(tenant.adminToken)).expect(200);

    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it('ignore à l’envoi une surcharge security.* préexistante insérée en base (modèle par défaut toujours)', async () => {
    const director = await createUserWithRole(app, tenant, 'director');
    const forged = 'Votre compte est bloqué, confirmez vos identifiants sur http://exemple.invalid';
    await app.get(TenantDb).runAs(tenant.tenantId, async (tx) => {
      for (const channel of ['email', 'inapp'] as const) {
        await tx.notificationTemplate.create({ data: { tenantId: tenant.tenantId, typeCode: 'security.policy_changed', channel, locale: 'fr', version: 1, subject: 'Urgent', body: forged } });
      }
      await app.get(SecurityAlertService).establishmentAlert(tx, tenant.tenantId, 'security.policy_changed', { audience: 'directors_and_owner', actorUserId: tenant.adminUserId }, new Date());
    });

    await runDispatcher(app, new Date(Date.now() + MINUTE_MS), tenant);

    const mail = memoryMailer(app).lastTo(director.email)!;
    expect(mail).toBeDefined();
    expect(`${mail.subject}${mail.text}`).not.toContain(forged);
    const rows = await app.get(TenantDb).runAs(tenant.tenantId, (tx) => tx.inAppMessage.findMany({ where: { userId: director.userId, typeCode: 'security.policy_changed' } }));
    expect(rows).toHaveLength(1);
    expect(`${rows[0]!.title}${rows[0]!.body}`).not.toContain(forged);
    const listed = await http(app).get(`${URL_BASE}?typeCode=security.policy_changed`).set(bearer(tenant.adminToken)).expect(200);
    expect((listed.body.data as { source: string }[]).every((t) => t.source === 'default')).toBe(true);
  });
});
