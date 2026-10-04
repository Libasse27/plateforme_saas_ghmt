import type { INestApplication } from '@nestjs/common';
import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createTenantFixture, createUserWithRole, issueToken, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { acceptInvitationFor, invitationTokenFor, mailerOf } from '../helpers/invitations';
import { postLogin } from '../auth/auth-helpers';
import { createTestApp } from '../helpers/test-app';
import { auditEntries, bearer, createCustomRole, createSite } from './support';

const BASE = '/api/v1/iam/users';
const UNKNOWN_ID = '0198a000-0000-7000-8000-0000000000ff';
let counter = 0;
const newUser = (tenant: TenantFixture, extra: Record<string, unknown> = {}) => ({
  fullName: 'Awa Diop',
  email: `awa${(counter += 1)}@${tenant.slug}.test`,
  ...extra,
});

describe('iam : utilisateurs (HTTP)', () => {
  let app: INestApplication;
  let a: TenantFixture;
  let b: TenantFixture;
  let receptionist: UserFixture;
  const http = () => request(app.getHttpServer());
  const createUser = (body: Record<string, unknown>, token = a.adminToken) => http().post(BASE).set(bearer(token)).send(body);

  beforeAll(async () => {
    app = await createTestApp();
    [a, b] = await Promise.all([createTenantFixture(app, { prefix: 'iam-a' }), createTenantFixture(app, { prefix: 'iam-b' })]);
    receptionist = await createUserWithRole(app, a, 'receptionist');
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('création', () => {
    it('crée un utilisateur invité sans identifiants et lui envoie un e-mail d’invitation', async () => {
      const body = newUser(a);

      const res = await createUser(body).expect(201);

      expect(res.body.data).toMatchObject({ email: body.email, fullName: 'Awa Diop', status: 'invited', locale: 'fr', mustChangePassword: false, assignments: [] });
      const credential = await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.userCredential.findFirst({ where: { userId: res.body.data.id } }));
      expect(credential).toBeNull();
      const mail = mailerOf(app).lastTo(body.email);
      expect(mail?.subject).toContain('Invitation');
      expect(mail?.text).toMatch(new RegExp(`^http://localhost:3001/invitation/${a.tenantId}\\.[A-Za-z0-9_-]{43}$`, 'm'));
    });

    it('stocke seulement l’empreinte SHA-256 du jeton (TTL 72 h) et ne le renvoie jamais dans la réponse', async () => {
      const body = newUser(a);

      const res = await createUser(body).expect(201);

      const token = invitationTokenFor(app, body.email);
      const secret = token.split('.')[1]!;
      const row = await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.invitation.findFirstOrThrow({ where: { userId: res.body.data.id } }));
      expect(Buffer.from(row.tokenHash).toString('hex')).toBe(createHash('sha256').update(secret).digest('hex'));
      const ttlHours = (row.expiresAt.getTime() - Date.now()) / 3_600_000;
      expect(ttlHours).toBeGreaterThan(71.9);
      expect(ttlHours).toBeLessThanOrEqual(72);
      expect(JSON.stringify(res.body)).not.toContain(secret);
      expect(JSON.stringify(res.headers)).not.toContain(secret);
    });

    it('n’accepte plus de mot de passe imposé : un champ password est ignoré', async () => {
      const body = { ...newUser(a), password: 'Imposé-par-admin-2026' };

      const res = await createUser(body).expect(201);

      expect(res.body.data.status).toBe('invited');
      const credential = await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.userCredential.findFirst({ where: { userId: res.body.data.id } }));
      expect(credential).toBeNull();
    });

    it('ne renvoie jamais de hash ni de jeton', async () => {
      const res = await createUser(newUser(a)).expect(201);
      const detail = await http().get(`${BASE}/${res.body.data.id}`).set(bearer(a.adminToken)).expect(200);

      const serialized = JSON.stringify([res.body, detail.body]);

      expect(serialized.toLowerCase()).not.toContain('passwordhash');
      expect(serialized).not.toContain('password_hash');
      expect(serialized).not.toContain('$argon2');
      expect(serialized.toLowerCase()).not.toContain('token');
    });

    it('crée les affectations dans la même transaction', async () => {
      const siteId = await createSite(app, a, 'IAM-S1');
      const { id: roleId } = await createCustomRole(app, a, ['iam:user:read', 'org:site:read'], 'lecteur_equipe');

      const res = await createUser(
        newUser(a, { roleAssignments: [{ roleId, scopeType: 'tenant' }, { roleId, scopeType: 'site', scopeId: siteId }] }),
      ).expect(201);

      expect(res.body.data.assignments).toHaveLength(2);
      expect(res.body.data.assignments[0]).toMatchObject({ roleCode: 'lecteur_equipe' });
    });

    it('annule tout (aucun utilisateur créé) si une affectation est invalide', async () => {
      const body = newUser(a, { roleAssignments: [{ roleId: UNKNOWN_ID, scopeType: 'tenant' }] });

      const res = await createUser(body).expect(422);

      expect(res.body.code).toBe('role_not_found');
      const rows = await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.user.count({ where: { email: body.email } }));
      expect(rows).toBe(0);
    });

    it('refuse un e-mail déjà utilisé, quelle que soit la casse (409)', async () => {
      const body = newUser(a);
      await createUser(body).expect(201);

      const res = await createUser({ ...body, email: body.email.toUpperCase() }).expect(409);

      expect(res.body.code).toBe('email_already_used');
    });

    it('autorise le même e-mail dans un autre établissement', async () => {
      const body = newUser(a);
      await createUser(body).expect(201);

      await createUser({ ...body, email: body.email.replace(a.slug, b.slug) }, b.adminToken).expect(201);
    });

    it.each([
      ['e-mail invalide', { email: 'pas-un-email' }],
      ['nom trop court', { fullName: 'A' }],
      ['langue inconnue', { locale: 'de' }],
      ['portée site sans scopeId', { roleAssignments: [{ roleId: UNKNOWN_ID, scopeType: 'site' }] }],
    ])('rejette un corps invalide : %s (422)', async (_label, override) => {
      const res = await createUser(newUser(a, override)).expect(422);

      expect(res.body.code).toBe('validation_failed');
    });

    it('refuse à un rôle sans permission (403) et sans jeton (401)', async () => {
      await createUser(newUser(a), receptionist.token).expect(403);
      await http().post(BASE).send(newUser(a)).expect(401);
    });

    it('audite la création sans donnée sensible', async () => {
      const res = await createUser(newUser(a)).expect(201);

      const entry = (await auditEntries(app, a.tenantId, 'iam.user.created')).find((e) => e.resourceId === res.body.data.id);

      expect(entry).toBeDefined();
      const dump = JSON.stringify(entry?.changes);
      expect(dump).not.toMatch(/password|hash|token|@/i);
    });
  });

  describe('lecture', () => {
    it('refuse la liste à un rôle sans permission iam:user:read (403)', async () => {
      await http().get(BASE).set(bearer(receptionist.token)).expect(403);
    });

    it('pagine par curseur sans doublon ni omission', async () => {
      const created = await Promise.all(Array.from({ length: 5 }, () => createUser(newUser(a)).then((r) => r.body.data.id as string)));

      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const res = await http().get(BASE).query({ limit: 2, ...(cursor ? { cursor } : {}) }).set(bearer(a.adminToken)).expect(200);
        expect(res.body.data.length).toBeLessThanOrEqual(2);
        seen.push(...res.body.data.map((u: { id: string }) => u.id));
        cursor = res.body.meta.pagination.nextCursor ?? undefined;
        pages += 1;
      } while (cursor && pages < 50);

      expect(new Set(seen).size).toBe(seen.length);
      expect(created.every((id) => seen.includes(id))).toBe(true);
    });

    it('filtre par statut et par recherche texte (nom ou e-mail)', async () => {
      const target = (await createUser(newUser(a, { fullName: 'Zoulikha Recherchable' })).expect(201)).body.data.id as string;
      await http().post(`${BASE}/${target}/disable`).set(bearer(a.adminToken)).expect(200);

      const byStatus = await http().get(BASE).query({ status: 'disabled', limit: 100 }).set(bearer(a.adminToken)).expect(200);
      const byName = await http().get(BASE).query({ q: 'zoulikha recherch' }).set(bearer(a.adminToken)).expect(200);
      const byMail = await http().get(BASE).query({ q: a.slug, limit: 100 }).set(bearer(a.adminToken)).expect(200);

      expect(byStatus.body.data.every((u: { status: string }) => u.status === 'disabled')).toBe(true);
      expect(byStatus.body.data.some((u: { id: string }) => u.id === target)).toBe(true);
      expect(byName.body.data.map((u: { id: string }) => u.id)).toEqual([target]);
      expect(byMail.body.data.length).toBeGreaterThan(1);
    });

    it('rejette un curseur qui n’est pas un UUID (422, L3)', async () => {
      for (const cursor of ['bidon', Buffer.from('pas-un-uuid').toString('base64url')]) {
        const res = await http().get(BASE).query({ cursor }).set(bearer(a.adminToken)).expect(422);
        expect(res.body.errors[0].path).toBe('cursor');
      }
    });

    it('rejette des paramètres de liste invalides (422)', async () => {
      await http().get(BASE).query({ status: 'inconnu' }).set(bearer(a.adminToken)).expect(422);
      await http().get(BASE).query({ limit: 1000 }).set(bearer(a.adminToken)).expect(422);
    });

    it('ne liste que les utilisateurs de son établissement', async () => {
      const res = await http().get(BASE).query({ limit: 100 }).set(bearer(b.adminToken)).expect(200);

      expect(res.body.data.some((u: { id: string }) => u.id === a.adminUserId)).toBe(false);
      expect(res.body.data.some((u: { id: string }) => u.id === b.adminUserId)).toBe(true);
    });

    it('renvoie le détail avec les affectations actives', async () => {
      const res = await http().get(`${BASE}/${a.adminUserId}`).set(bearer(a.adminToken)).expect(200);

      expect(res.body.data.assignments).toEqual([expect.objectContaining({ roleCode: 'tenant_admin', scopeType: 'tenant', scopeId: null })]);
    });

    it('répond 404 pour un utilisateur inconnu, mal formé ou d’un autre établissement', async () => {
      await http().get(`${BASE}/${UNKNOWN_ID}`).set(bearer(a.adminToken)).expect(404);
      await http().get(`${BASE}/nimporte-quoi`).set(bearer(a.adminToken)).expect(404);
      await http().get(`${BASE}/${b.adminUserId}`).set(bearer(a.adminToken)).expect(404);
    });
  });

  describe('modification, activation, sessions', () => {
    /** Utilisateur actif : créé par invitation puis activé par l'acceptation du lien (flux réel). */
    const makeUser = async () => {
      const body = newUser(a);
      const id = (await createUser(body).expect(201)).body.data.id as string;
      await acceptInvitationFor(app, body.email);
      return id;
    };

    it('modifie le nom et la langue et audite sans exposer le nom', async () => {
      const id = await makeUser();

      const res = await http().patch(`${BASE}/${id}`).set(bearer(a.adminToken)).send({ fullName: 'Nouveau Nom', locale: 'en' }).expect(200);

      expect(res.body.data).toMatchObject({ fullName: 'Nouveau Nom', locale: 'en' });
      const entry = (await auditEntries(app, a.tenantId, 'iam.user.updated')).find((e) => e.resourceId === id);
      expect(entry?.changes).toEqual({ fields: ['fullName', 'locale'], before: { locale: 'fr' }, after: { locale: 'en' } });
    });

    it('rejette une modification vide ou invalide (422) et un champ interdit est ignoré', async () => {
      const id = await makeUser();

      await http().patch(`${BASE}/${id}`).set(bearer(a.adminToken)).send({}).expect(422);
      await http().patch(`${BASE}/${id}`).set(bearer(a.adminToken)).send({ locale: 'xx' }).expect(422);
      const res = await http().patch(`${BASE}/${id}`).set(bearer(a.adminToken)).send({ fullName: 'Ok Valide', status: 'disabled', email: 'x@y.fr' }).expect(200);
      expect(res.body.data.status).toBe('active');
      expect(res.body.data.email).not.toBe('x@y.fr');
    });

    it('refuse la modification à un rôle sans permission (403) et répond 404 cross-tenant', async () => {
      const id = await makeUser();

      await http().patch(`${BASE}/${id}`).set(bearer(receptionist.token)).send({ fullName: 'Piraté' }).expect(403);
      await http().patch(`${BASE}/${b.adminUserId}`).set(bearer(a.adminToken)).send({ fullName: 'Intrusion' }).expect(404);
    });

    it('désactive un utilisateur, révoque ses sessions : son jeton reçoit 401', async () => {
      const user = await createUserWithRole(app, a, 'receptionist');
      await http().get('/api/v1/org/sites').set(bearer(user.token)).expect(200);

      const res = await http().post(`${BASE}/${user.userId}/disable`).set(bearer(a.adminToken)).expect(200);

      expect(res.body.data.status).toBe('disabled');
      await http().get('/api/v1/org/sites').set(bearer(user.token)).expect(401);
      const sessions = await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.session.findMany({ where: { userId: user.userId } }));
      expect(sessions.every((s) => s.revokedAt !== null && s.revokedReason === 'user_disabled')).toBe(true);
      const entry = (await auditEntries(app, a.tenantId, 'iam.user.disabled')).find((e) => e.resourceId === user.userId);
      expect(entry?.changes).toMatchObject({ before: { status: 'active' }, after: { status: 'disabled' }, revokedSessions: 1 });
    });

    it('désactiver est idempotent, et réactiver rend le compte actif (nouvelle session nécessaire)', async () => {
      const user = await createUserWithRole(app, a, 'receptionist');
      await http().post(`${BASE}/${user.userId}/disable`).set(bearer(a.adminToken)).expect(200);
      await http().post(`${BASE}/${user.userId}/disable`).set(bearer(a.adminToken)).expect(200);

      const res = await http().post(`${BASE}/${user.userId}/enable`).set(bearer(a.adminToken)).expect(200);

      expect(res.body.data.status).toBe('active');
      await http().get('/api/v1/org/sites').set(bearer(user.token)).expect(401);
      const fresh = await issueToken(app, a.tenantId, user.userId);
      await http().get('/api/v1/org/sites').set(bearer(fresh)).expect(200);
      await http().post(`${BASE}/${user.userId}/enable`).set(bearer(a.adminToken)).expect(200);
    });

    it('réactiver un utilisateur désactivé sans identifiants (invitation non acceptée) le repasse en invited, pas en active', async () => {
      const body = newUser(a);
      const id = (await createUser(body).expect(201)).body.data.id as string;
      await http().post(`${BASE}/${id}/disable`).set(bearer(a.adminToken)).expect(200);

      const res = await http().post(`${BASE}/${id}/enable`).set(bearer(a.adminToken)).expect(200);

      expect(res.body.data.status).toBe('invited');
      await http().post(`${BASE}/${id}/invitation`).set(bearer(a.adminToken)).expect(204);
      const entry = (await auditEntries(app, a.tenantId, 'iam.user.enabled')).find((e) => e.resourceId === id);
      expect(entry?.changes).toMatchObject({ before: { status: 'disabled' }, after: { status: 'invited' } });
    });

    it('refuse de réactiver un utilisateur invité (409 invalid_state)', async () => {
      const id = (await createUser(newUser(a)).expect(201)).body.data.id as string;

      const res = await http().post(`${BASE}/${id}/enable`).set(bearer(a.adminToken)).expect(409);

      expect(res.body.code).toBe('invalid_state');
    });

    it('refuse disable/enable à un rôle sans permission (403) et répond 404 cross-tenant', async () => {
      const id = await makeUser();

      await http().post(`${BASE}/${id}/disable`).set(bearer(receptionist.token)).expect(403);
      await http().post(`${BASE}/${b.adminUserId}/disable`).set(bearer(a.adminToken)).expect(404);
      await http().post(`${BASE}/${b.adminUserId}/enable`).set(bearer(a.adminToken)).expect(404);
    });

    it('révoque toutes les sessions d’un utilisateur (204) : son jeton reçoit 401', async () => {
      const user = await createUserWithRole(app, a, 'receptionist');
      const second = await issueToken(app, a.tenantId, user.userId);

      await http().delete(`${BASE}/${user.userId}/sessions`).set(bearer(a.adminToken)).expect(204);

      await http().get('/api/v1/org/sites').set(bearer(user.token)).expect(401);
      await http().get('/api/v1/org/sites').set(bearer(second)).expect(401);
      expect((await auditEntries(app, a.tenantId, 'iam.session.revoked')).some((e) => e.resourceId === user.userId)).toBe(true);
    });

    it('refuse la révocation de sessions sans permission (403) et répond 404 cross-tenant', async () => {
      await http().delete(`${BASE}/${a.adminUserId}/sessions`).set(bearer(receptionist.token)).expect(403);
      await http().delete(`${BASE}/${b.adminUserId}/sessions`).set(bearer(a.adminToken)).expect(404);
      await http().get('/api/v1/org/sites').set(bearer(b.adminToken)).expect(200);
    });
  });

  describe('déverrouillage (C8)', () => {
    const lock = (userId: string) =>
      app.get(TenantDb).runAs(a.tenantId, (tx) =>
        tx.userCredential.update({
          where: { tenantId_userId: { tenantId: a.tenantId, userId } },
          data: { failedAttempts: 5, lockedUntil: new Date(Date.now() + 3_600_000) },
        }),
      );

    it('remet à zéro les échecs et le verrou : la connexion redevient possible, avec audit', async () => {
      const user = await createUserWithRole(app, a, 'receptionist');
      await lock(user.userId);
      await postLogin(app, a.slug, user.email).expect(401);

      const res = await http().post(`${BASE}/${user.userId}/unlock`).set(bearer(a.adminToken)).expect(200);

      expect(res.body.data).toMatchObject({ id: user.userId, status: 'active' });
      await postLogin(app, a.slug, user.email).expect(200);
      const credential = await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.userCredential.findFirstOrThrow({ where: { userId: user.userId } }));
      expect(credential).toMatchObject({ failedAttempts: 0, lockedUntil: null });
      const entry = (await auditEntries(app, a.tenantId, 'iam.user.unlocked')).find((e) => e.resourceId === user.userId);
      expect(entry).toMatchObject({ actorUserId: a.adminUserId, outcome: 'success' });
    });

    it('est idempotent et accepté pour un utilisateur sans identifiants (invité)', async () => {
      const invited = (await createUser(newUser(a)).expect(201)).body.data.id as string;

      await http().post(`${BASE}/${invited}/unlock`).set(bearer(a.adminToken)).expect(200);
      await http().post(`${BASE}/${invited}/unlock`).set(bearer(a.adminToken)).expect(200);
    });

    it('refuse sans permission iam:user:update (403) et sans jeton (401), 404 pour un autre établissement ou un identifiant mal formé', async () => {
      await http().post(`${BASE}/${a.adminUserId}/unlock`).set(bearer(receptionist.token)).expect(403);
      await http().post(`${BASE}/${a.adminUserId}/unlock`).expect(401);
      await http().post(`${BASE}/${b.adminUserId}/unlock`).set(bearer(a.adminToken)).expect(404);
      await http().post(`${BASE}/pas-un-uuid/unlock`).set(bearer(a.adminToken)).expect(404);
    });
  });
});
