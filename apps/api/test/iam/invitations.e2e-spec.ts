import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { distinctClientIp, postLogin } from '../auth/auth-helpers';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { invitationTokenFor, mailerOf } from '../helpers/invitations';
import { createTestApp } from '../helpers/test-app';
import { auditEntries, bearer, createCustomRole } from './support';

const USERS = '/api/v1/iam/users';
const INVITATIONS = '/api/v1/auth/invitations';
const CHOSEN_PASSWORD = 'Mon-choix-perso-2026!';
let counter = 0;

describe('iam : invitations (C6)', () => {
  let app: INestApplication;
  let tenantDb: TenantDb;
  let a: TenantFixture;
  let b: TenantFixture;
  let receptionist: UserFixture;
  const http = () => request(app.getHttpServer());
  const publicCall = <T extends request.Test>(call: T): T => call.set('X-Forwarded-For', distinctClientIp()) as T;

  async function invite(overrides: Record<string, unknown> = {}, tenant = a) {
    counter += 1;
    const email = `invite${counter}@${tenant.slug}.test`;
    const res = await http()
      .post(USERS)
      .set(bearer(tenant.adminToken))
      .send({ fullName: 'Fatou Invitée', email, ...overrides })
      .expect(201);
    return { email, userId: res.body.data.id as string, token: invitationTokenFor(app, email) };
  }

  beforeAll(async () => {
    app = await createTestApp();
    tenantDb = app.get(TenantDb);
    [a, b] = await Promise.all([createTenantFixture(app, { prefix: 'inv-a' }), createTenantFixture(app, { prefix: 'inv-b' })]);
    receptionist = await createUserWithRole(app, a, 'receptionist');
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('aperçu public (GET /auth/invitations/:token)', () => {
    it('renvoie email, nom et nom de l’établissement, sans authentification', async () => {
      const { email, token } = await invite();

      const res = await publicCall(http().get(`${INVITATIONS}/${token}`)).expect(200);

      expect(res.body.data).toEqual({ email, fullName: 'Fatou Invitée', tenantName: `Clinique ${a.slug}` });
    });

    it.each([
      ['jeton mal formé', 'pas-un-jeton'],
      ['jeton inconnu', `${'0198a000-0000-7000-8000-000000000001'}.${randomBytes(32).toString('base64url')}`],
    ])('répond 410 invitation_expired : %s', async (_label, token) => {
      const res = await publicCall(http().get(`${INVITATIONS}/${token}`)).expect(410);

      expect(res.body.code).toBe('invitation_expired');
    });

    it('répond 410 si le secret est valide mais présenté avec le tenantId d’un autre établissement', async () => {
      const { token } = await invite();
      const crossTenant = `${b.tenantId}.${token.split('.')[1]}`;

      await publicCall(http().get(`${INVITATIONS}/${crossTenant}`)).expect(410);
    });

    it('répond 410 une fois l’invitation expirée', async () => {
      const { userId, token } = await invite();
      await tenantDb.runAs(a.tenantId, (tx) => tx.invitation.updateMany({ where: { userId }, data: { expiresAt: new Date(Date.now() - 1000) } }));

      const res = await publicCall(http().get(`${INVITATIONS}/${token}`)).expect(410);
      await publicCall(http().post(`${INVITATIONS}/${token}/accept`)).send({ password: CHOSEN_PASSWORD }).expect(410);

      expect(res.body.code).toBe('invitation_expired');
    });
  });

  describe('acceptation (POST /auth/invitations/:token/accept)', () => {
    it('parcours complet : e-mail capturé, acceptation, connexion avec le mot de passe choisi', async () => {
      const { email, userId, token } = await invite();
      await postLogin(app, a.slug, email, CHOSEN_PASSWORD).expect(401);

      await publicCall(http().post(`${INVITATIONS}/${token}/accept`)).send({ password: CHOSEN_PASSWORD }).expect(204);

      const login = await postLogin(app, a.slug, email, CHOSEN_PASSWORD).expect(200);
      expect(login.body.data.accessToken).toEqual(expect.any(String));
      const user = await http().get(`${USERS}/${userId}`).set(bearer(a.adminToken)).expect(200);
      expect(user.body.data).toMatchObject({ status: 'active', mustChangePassword: false });
      const stored = await tenantDb.runAs(a.tenantId, (tx) => tx.user.findFirstOrThrow({ where: { id: userId } }));
      expect(stored.emailVerifiedAt).toBeInstanceOf(Date);
      const credential = await tenantDb.runAs(a.tenantId, (tx) => tx.userCredential.findFirstOrThrow({ where: { userId } }));
      expect(credential.passwordHash).toMatch(/^\$argon2id\$/);
    });

    it('est à usage unique : une seconde acceptation ou un aperçu répond 410', async () => {
      const { token } = await invite();
      await publicCall(http().post(`${INVITATIONS}/${token}/accept`)).send({ password: CHOSEN_PASSWORD }).expect(204);

      await publicCall(http().post(`${INVITATIONS}/${token}/accept`)).send({ password: 'Autre-mot-de-passe-2026' }).expect(410);
      await publicCall(http().get(`${INVITATIONS}/${token}`)).expect(410);
    });

    it('garantit un seul gagnant pour deux acceptations simultanées', async () => {
      const { email, token } = await invite();

      const results = await Promise.all([
        publicCall(http().post(`${INVITATIONS}/${token}/accept`)).send({ password: CHOSEN_PASSWORD }),
        publicCall(http().post(`${INVITATIONS}/${token}/accept`)).send({ password: 'Seconde-tentative-2026' }),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([204, 410]);
      await postLogin(app, a.slug, email, results[0]!.status === 204 ? CHOSEN_PASSWORD : 'Seconde-tentative-2026').expect(200);
    });

    it('refuse avec 422 un mot de passe trop court ou absent, et laisse l’invitation valide', async () => {
      const { token } = await invite();

      await publicCall(http().post(`${INVITATIONS}/${token}/accept`)).send({ password: 'court' }).expect(422);
      await publicCall(http().post(`${INVITATIONS}/${token}/accept`)).send({}).expect(422);

      await publicCall(http().get(`${INVITATIONS}/${token}`)).expect(200);
    });

    it('refuse (410) si l’utilisateur a été désactivé entre-temps', async () => {
      const { userId, token } = await invite();
      await http().post(`${USERS}/${userId}/disable`).set(bearer(a.adminToken)).expect(200);

      await publicCall(http().post(`${INVITATIONS}/${token}/accept`)).send({ password: CHOSEN_PASSWORD }).expect(410);
    });

    it('audite l’invitation et son acceptation sans jeton ni mot de passe', async () => {
      const { userId, token } = await invite();
      await publicCall(http().post(`${INVITATIONS}/${token}/accept`)).send({ password: CHOSEN_PASSWORD }).expect(204);

      const entries = [
        ...(await auditEntries(app, a.tenantId, 'iam.user.invited')),
        ...(await auditEntries(app, a.tenantId, 'iam.user.invitation_accepted')),
      ].filter((e) => e.resourceId === userId);

      expect(entries.map((e) => e.action).sort()).toEqual(['iam.user.invitation_accepted', 'iam.user.invited']);
      const dump = JSON.stringify(entries.map((e) => e.changes));
      expect(dump).not.toContain(token.split('.')[1]);
      expect(dump).not.toContain(CHOSEN_PASSWORD);
    });
  });

  describe('renvoi (POST /iam/users/:id/invitation)', () => {
    it('envoie un nouvel e-mail et invalide le précédent lien', async () => {
      const { email, userId, token: first } = await invite();
      mailerOf(app).clear();

      await http().post(`${USERS}/${userId}/invitation`).set(bearer(a.adminToken)).expect(204);

      const second = invitationTokenFor(app, email);
      expect(second).not.toBe(first);
      await publicCall(http().get(`${INVITATIONS}/${first}`)).expect(410);
      await publicCall(http().post(`${INVITATIONS}/${second}/accept`)).send({ password: CHOSEN_PASSWORD }).expect(204);
      const log = await auditEntries(app, a.tenantId, 'iam.user.invitation_resent');
      expect(log.some((e) => e.resourceId === userId)).toBe(true);
    });

    it('refuse (409 invalid_state) pour un utilisateur déjà actif', async () => {
      const res = await http().post(`${USERS}/${receptionist.userId}/invitation`).set(bearer(a.adminToken)).expect(409);

      expect(res.body.code).toBe('invalid_state');
    });

    it('refuse sans permission (403), sans jeton (401) et répond 404 pour un autre établissement', async () => {
      const { userId } = await invite();
      const foreign = await invite({}, b);

      await http().post(`${USERS}/${userId}/invitation`).set(bearer(receptionist.token)).expect(403);
      await http().post(`${USERS}/${userId}/invitation`).expect(401);
      await http().post(`${USERS}/${foreign.userId}/invitation`).set(bearer(a.adminToken)).expect(404);
      await http().post(`${USERS}/pas-un-uuid/invitation`).set(bearer(a.adminToken)).expect(404);
    });
  });

  describe('envoi de l’e-mail', () => {
    it('répond 502 invitation_email_failed sans révéler le lien, et le renvoi reste possible', async () => {
      counter += 1;
      const email = `panne${counter}@${a.slug}.test`;
      mailerOf(app).failOnNextSend();

      const res = await http().post(USERS).set(bearer(a.adminToken)).send({ fullName: 'Panne SMTP', email }).expect(502);

      expect(res.body.code).toBe('invitation_email_failed');
      expect(JSON.stringify(res.body)).not.toMatch(/invitation\//);
      const list = await http().get(USERS).query({ q: email }).set(bearer(a.adminToken)).expect(200);
      expect(list.body.data[0]).toMatchObject({ email, status: 'invited' });
      await http().post(`${USERS}/${list.body.data[0].id}/invitation`).set(bearer(a.adminToken)).expect(204);
      expect(invitationTokenFor(app, email)).toEqual(expect.any(String));
    });
  });

  describe('isolation et audit des rôles sensibles (H2)', () => {
    it('l’invitation d’un établissement est introuvable depuis un autre (RLS)', async () => {
      const { userId } = await invite();

      const seenFromB = await tenantDb.runAs(b.tenantId, (tx) => tx.invitation.count({ where: { userId } }));

      expect(seenFromB).toBe(0);
    });

    it('audite iam.role.sensitive_assigned à l’affectation d’un rôle clinique ou financier, pas d’un rôle administratif', async () => {
      const doctorRole = await tenantDb.runAs(a.tenantId, (tx) => tx.role.findFirstOrThrow({ where: { code: 'doctor' }, select: { id: true } }));
      const readerRole = await createCustomRole(app, a, ['org:site:read']);
      const target = await invite({ roleAssignments: [{ roleId: doctorRole.id, scopeType: 'tenant' }, { roleId: readerRole.id, scopeType: 'tenant' }] });
      const later = await invite();
      await http().post(`${USERS}/${later.userId}/assignments`).set(bearer(a.adminToken)).send({ roleId: doctorRole.id, scopeType: 'tenant' }).expect(201);
      await http().post(`${USERS}/${later.userId}/assignments`).set(bearer(a.adminToken)).send({ roleId: readerRole.id, scopeType: 'tenant' }).expect(201);

      const entries = await auditEntries(app, a.tenantId, 'iam.role.sensitive_assigned');

      for (const userId of [target.userId, later.userId]) {
        const mine = entries.filter((e) => (e.changes as { userId: string }).userId === userId);
        expect(mine).toHaveLength(1);
        expect(mine[0]!.changes).toMatchObject({ roleCode: 'doctor', scopeType: 'tenant' });
        expect(mine[0]!.actorUserId).toBe(a.adminUserId);
      }
    });
  });
});
