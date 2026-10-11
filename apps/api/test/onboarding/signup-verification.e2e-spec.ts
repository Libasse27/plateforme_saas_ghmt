import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Clock } from '../../src/common/time/clock';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { AUTH, bearer, http, postLogin } from '../auth/auth-helpers';
import { FIXTURE_PASSWORD, signupInput } from '../helpers/fixtures';
import { MutableClock } from '../helpers/mutable-clock';
import { createTestApp } from '../helpers/test-app';
import { drainDeferred, mailerOf, postResend, postSignup, postVerify, signUp, tenantRow, tokenFromMail, uniqueSlug } from './onboarding-helpers';

describe('onboarding : inscription vérifiée (docs/11 D12)', () => {
  let app: INestApplication;
  const clock = new MutableClock();

  beforeAll(async () => {
    app = await createTestApp({}, { providerOverrides: [{ token: Clock, useValue: clock }] });
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('POST /auth/signup', () => {
    it('crée un tenant pending, envoie le lien de vérification et trace l’audit', async () => {
      const signed = await signUp(app);

      const tenant = await tenantRow(app, signed.tenantId);
      expect(tenant.status).toBe('pending');
      const mail = mailerOf(app).lastTo(signed.input.admin.email);
      expect(mail?.text).toContain(`/inscription/confirmer/${signed.token}`);
      expect(mail?.text).toContain(signed.slug);

      const { user, audit, verification } = await app.get(TenantDb).runAs(signed.tenantId, async (tx) => ({
        user: await tx.user.findFirstOrThrow({ where: { email: signed.input.admin.email } }),
        audit: await tx.auditLog.findMany({ where: { action: 'tenant.signup_verification_sent' } }),
        verification: await tx.signupVerification.findMany(),
      }));
      expect(user).toMatchObject({ status: 'active', emailVerifiedAt: null });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorType: 'user', actorUserId: user.id });
      expect(verification).toHaveLength(1);
      expect(verification[0]!.expiresAt.getTime() - clock.now().getTime()).toBe(24 * 3600 * 1000);
    });

    it('ne stocke que l’empreinte du jeton, jamais sa valeur', async () => {
      const signed = await signUp(app);

      const rows = await app.get(TenantDb).runAs(signed.tenantId, (tx) => tx.$queryRaw<{ token_hash: Buffer }[]>`SELECT token_hash FROM tenant.signup_verifications`);
      const secret = signed.token.split('.')[1]!;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.token_hash.length).toBe(32);
      expect(rows[0]!.token_hash.toString('utf8')).not.toContain(secret);
    });

    it('ne démarre aucune session et refuse la connexion avant confirmation', async () => {
      const signed = await signUp(app);

      const login = await postLogin(app, signed.slug, signed.input.admin.email, FIXTURE_PASSWORD);

      expect(login.status).toBeGreaterThanOrEqual(401);
      expect(login.status).toBeLessThan(500);
      expect(login.body.data?.accessToken).toBeUndefined();
    });

    it.each(['admin', 'plateforme', 'api', 'ghmt-prod', 'ghmtclinique', 'xn--abc', 'XN--abc'.toLowerCase()])('refuse l’identifiant réservé « %s » (422 slug_reserved sur establishment.slug)', async (slug) => {
      const res = await postSignup(app, signupInput(slug)).expect(422);

      expect(res.body).toMatchObject({ status: 422, code: 'slug_reserved' });
      expect(res.body.errors).toEqual([expect.objectContaining({ path: 'establishment.slug', code: 'slug_reserved' })]);
    });

    it('ne crée aucun tenant pour un identifiant réservé', async () => {
      mailerOf(app).clear();
      await postSignup(app, signupInput('sandbox')).expect(422);

      expect(mailerOf(app).sent).toHaveLength(0);
    });

    it('refuse un identifiant déjà pris (409), y compris par un tenant pending', async () => {
      const signed = await signUp(app);

      const res = await postSignup(app, signupInput(signed.slug)).expect(409);

      expect(res.body).toMatchObject({ status: 409, code: 'slug_taken' });
    });

    it('répond 201 quand l’envoi SMTP échoue, et le renvoi permet de confirmer', async () => {
      const slug = uniqueSlug();
      const input = signupInput(slug);
      mailerOf(app).clear();
      mailerOf(app).failOnNextSend();

      const created = await postSignup(app, input).expect(201);
      expect(mailerOf(app).sent).toHaveLength(0);
      expect((await tenantRow(app, created.body.data.tenantId)).status).toBe('pending');

      await postResend(app, { tenantSlug: slug, email: input.admin.email }).expect(202);
      await drainDeferred(app);
      const token = tokenFromMail(mailerOf(app).lastTo(input.admin.email));
      await postVerify(app, token).expect(200);
      expect((await tenantRow(app, created.body.data.tenantId)).status).toBe('active');
    });

    it('envoie un e-mail au libellé fixe : ni le nom de l’établissement ni celui de la personne saisis', async () => {
      const signed = await signUp(app);

      const mail = mailerOf(app).lastTo(signed.input.admin.email)!;

      expect(mail.subject).toBe('Confirmez votre inscription à GHMT');
      expect(mail.text + (mail.html ?? '')).not.toContain(signed.input.establishment.legalName);
      expect(mail.text + (mail.html ?? '')).not.toContain(signed.input.admin.fullName);
    });

    it('limite à 5 e-mails par heure vers une même adresse, tous établissements confondus (201 sans envoi au-delà)', async () => {
      const victim = `victime-${uniqueSlug('v')}@exemple.test`;
      mailerOf(app).clear();
      const statuses: number[] = [];
      for (let i = 0; i < 7; i += 1) {
        const input = signupInput(uniqueSlug('spam'));
        statuses.push((await postSignup(app, { ...input, admin: { ...input.admin, email: victim } })).status);
      }

      expect(statuses).toEqual([201, 201, 201, 201, 201, 201, 201]);
      expect(mailerOf(app).sent.filter((m) => m.to === victim)).toHaveLength(5);
    });

    it('refuse un corps invalide (422) avec le détail des champs', async () => {
      const input = signupInput(uniqueSlug());

      const res = await postSignup(app, { ...input, admin: { ...input.admin, password: 'court' } }).expect(422);

      expect(res.body.code).toBe('validation_failed');
      expect(res.body.errors.map((e: { path: string }) => e.path)).toContain('admin.password');
    });
  });

  describe('POST /auth/signup/verify', () => {
    it('active le tenant, renseigne email_verified_at, audite, puis la connexion réussit', async () => {
      const signed = await signUp(app);

      const res = await postVerify(app, signed.token).expect(200);

      expect(res.body.data).toEqual({ tenantSlug: signed.slug });
      expect(res.body.data).not.toHaveProperty('accessToken');
      expect((await tenantRow(app, signed.tenantId)).status).toBe('active');
      const { user, audit } = await app.get(TenantDb).runAs(signed.tenantId, async (tx) => ({
        user: await tx.user.findFirstOrThrow({ where: { email: signed.input.admin.email } }),
        audit: await tx.auditLog.findMany({ where: { action: 'tenant.signup_verified' } }),
      }));
      expect(user.emailVerifiedAt).not.toBeNull();
      expect(audit).toHaveLength(1);

      const login = await postLogin(app, signed.slug, signed.input.admin.email, FIXTURE_PASSWORD).expect(200);
      const me = await http(app).get(`${AUTH}/me`).set(bearer(login.body.data.accessToken)).expect(200);
      expect(me.body.data.user.email).toBe(signed.input.admin.email);
    });

    it('refuse un jeton rejoué (410 verification_token_invalid)', async () => {
      const signed = await signUp(app);
      await postVerify(app, signed.token).expect(200);

      const replay = await postVerify(app, signed.token).expect(410);

      expect(replay.body).toMatchObject({ status: 410, code: 'verification_token_invalid' });
    });

    it('refuse un jeton expiré après 24 h (410) sans activer le tenant', async () => {
      const signed = await signUp(app);
      clock.advanceDays(1.01);
      try {
        await postVerify(app, signed.token).expect(410);
        expect((await tenantRow(app, signed.tenantId)).status).toBe('pending');
      } finally {
        clock.reset();
      }
    });

    it.each([
      ['inconnu', `0198a2b4-7c3d-7e11-8a52-3f6d2c9b1e04.${'A'.repeat(43)}`],
      ['d’un autre établissement forgé', `${'0'.repeat(8)}-0000-7000-8000-${'0'.repeat(12)}.${'B'.repeat(43)}`],
    ])('refuse un jeton %s (410, même réponse)', async (_label, token) => {
      const res = await postVerify(app, token).expect(410);

      expect(res.body).toMatchObject({ status: 410, code: 'verification_token_invalid' });
    });

    it('refuse un corps mal formé (422)', async () => {
      await http(app).post(`${AUTH}/signup/verify`).send({ token: 'x' }).expect(422);
      await http(app).post(`${AUTH}/signup/verify`).send({}).expect(422);
    });

    it('une seule de deux confirmations concurrentes réussit', async () => {
      const signed = await signUp(app);

      const results = await Promise.all([postVerify(app, signed.token), postVerify(app, signed.token)]);

      expect(results.map((r) => r.status).sort()).toEqual([200, 410]);
      expect((await tenantRow(app, signed.tenantId)).status).toBe('active');
    });

    it('refuse (410) et conserve le jeton quand le tenant n’est plus pending (suspendu)', async () => {
      const signed = await signUp(app);
      await app.get(PlatformDb).run((tx) => tx.tenant.update({ where: { id: signed.tenantId }, data: { status: 'suspended' } }));

      await postVerify(app, signed.token).expect(410);

      const remaining = await app.get(TenantDb).runAs(signed.tenantId, (tx) => tx.signupVerification.findMany({ select: { consumedAt: true } }));
      expect(remaining.every((row) => row.consumedAt === null)).toBe(true);
      expect((await tenantRow(app, signed.tenantId)).status).toBe('suspended');
    });
  });

  describe('POST /auth/signup/resend', () => {
    it('répond 202 identique pour un compte existant, inconnu ou un tenant inconnu ; un seul e-mail part', async () => {
      const signed = await signUp(app);
      mailerOf(app).clear();

      const known = await postResend(app, { tenantSlug: signed.slug, email: signed.input.admin.email }).expect(202);
      const unknownEmail = await postResend(app, { tenantSlug: signed.slug, email: 'inconnu@exemple.test' }).expect(202);
      const unknownTenant = await postResend(app, { tenantSlug: uniqueSlug('absent'), email: signed.input.admin.email }).expect(202);
      await drainDeferred(app);

      expect(known.body.data).toEqual({ accepted: true });
      expect(unknownEmail.body.data).toEqual(known.body.data);
      expect(unknownTenant.body.data).toEqual(known.body.data);
      expect(mailerOf(app).sent).toHaveLength(1);
      expect(mailerOf(app).sent[0]!.to).toBe(signed.input.admin.email);
    });

    it('invalide l’ancien jeton : seul le dernier lien fonctionne', async () => {
      const signed = await signUp(app);

      await postResend(app, { tenantSlug: signed.slug, email: signed.input.admin.email }).expect(202);
      await drainDeferred(app);
      const fresh = tokenFromMail(mailerOf(app).lastTo(signed.input.admin.email));

      expect(fresh).not.toBe(signed.token);
      await postVerify(app, signed.token).expect(410);
      await postVerify(app, fresh).expect(200);
    });

    it('n’envoie rien pour un tenant déjà actif', async () => {
      const signed = await signUp(app);
      await postVerify(app, signed.token).expect(200);
      mailerOf(app).clear();

      await postResend(app, { tenantSlug: signed.slug, email: signed.input.admin.email }).expect(202);
      await drainDeferred(app);

      expect(mailerOf(app).sent).toHaveLength(0);
    });

    it('n’envoie rien pour une inscription plus âgée que 7 jours', async () => {
      const signed = await signUp(app);
      mailerOf(app).clear();
      clock.advanceDays(8);
      try {
        await postResend(app, { tenantSlug: signed.slug, email: signed.input.admin.email }).expect(202);
        await drainDeferred(app);
      } finally {
        clock.reset();
      }

      expect(mailerOf(app).sent).toHaveLength(0);
    });

    it('audite le renvoi', async () => {
      const signed = await signUp(app);
      await postResend(app, { tenantSlug: signed.slug, email: signed.input.admin.email }).expect(202);
      await drainDeferred(app);

      const audit = await app.get(TenantDb).runAs(signed.tenantId, (tx) => tx.auditLog.findMany({ where: { action: 'tenant.signup_verification_sent' }, orderBy: { chainSeq: 'asc' } }));
      expect(audit).toHaveLength(2);
      expect(audit[1]!.changes).toMatchObject({ resend: true });
    });

    it('refuse un corps invalide (422)', async () => {
      await http(app).post(`${AUTH}/signup/resend`).send({ tenantSlug: 'x', email: 'pas-un-email' }).expect(422);
    });

    it('limite à 3 renvois par heure et par identifiant (429), même depuis des IP différentes', async () => {
      const signed = await signUp(app);
      const statuses: number[] = [];
      for (let i = 0; i < 5; i += 1) statuses.push((await postResend(app, { tenantSlug: signed.slug, email: signed.input.admin.email })).status);
      await drainDeferred(app);

      expect(statuses).toEqual([202, 202, 202, 429, 429]);
    });

    it('limite à 5 renvois par heure et par IP (429)', async () => {
      const ip = '198.51.100.77';
      const statuses: number[] = [];
      for (let i = 0; i < 7; i += 1) statuses.push((await postResend(app, { tenantSlug: uniqueSlug('lim'), email: `lim${i}@exemple.test` }, ip)).status);

      expect(statuses).toEqual([202, 202, 202, 202, 202, 429, 429]);
    });
  });

  describe('POST /auth/signup/verify : limite de débit', () => {
    it('limite à 20 tentatives par 15 minutes et par IP (429)', async () => {
      const ip = '198.51.100.88';
      const token = `0198a2b4-7c3d-7e11-8a52-3f6d2c9b1e04.${'A'.repeat(43)}`;
      const statuses: number[] = [];
      for (let i = 0; i < 22; i += 1) statuses.push((await http(app).post(`${AUTH}/signup/verify`).set('X-Forwarded-For', ip).send({ token })).status);

      expect(statuses.slice(0, 20).every((s) => s === 410)).toBe(true);
      expect(statuses.slice(20)).toEqual([429, 429]);
    });
  });
});
