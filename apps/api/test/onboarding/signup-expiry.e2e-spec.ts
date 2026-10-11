import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { PendingSignupExpiryJob } from '../../src/modules/onboarding/pending-signup-expiry.job';
import { createTenantFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { postSignup, postVerify, signUp, tenantRow, uniqueSlug } from './onboarding-helpers';
import { signupInput } from '../helpers/fixtures';

const DAY_MS = 24 * 3600 * 1000;

describe('onboarding : expiration des inscriptions non confirmées (docs/11 §6.3)', () => {
  let app: INestApplication;
  let job: PendingSignupExpiryJob;

  beforeAll(async () => {
    app = await createTestApp();
    job = app.get(PendingSignupExpiryJob);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('ne programme aucune tâche de fond sous test (SECURITY_JOBS_ENABLED=false)', () => {
    expect(() => job.onApplicationBootstrap()).not.toThrow();
  });

  it('à +8 jours : terminated, supprimé, identifiant renommé expired-<id> et audit plateforme', async () => {
    const signed = await signUp(app);

    const report = await job.runOnce(new Date(Date.now() + 8 * DAY_MS), { tenantIds: [signed.tenantId] });

    expect(report).toMatchObject({ expired: 1, errors: 0 });
    const tenant = await tenantRow(app, signed.tenantId);
    expect(tenant).toMatchObject({ status: 'terminated', slug: `expired-${signed.tenantId}` });
    expect(tenant.deletedAt).not.toBeNull();
    const audit = await app.get(PlatformDb).run((tx) => tx.platformAuditLog.findMany({ where: { action: 'tenant.signup_expired', tenantId: signed.tenantId } }));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: 'system', resourceType: 'tenant', resourceId: signed.tenantId });
    expect(audit[0]!.changes).toEqual({ tenantId: signed.tenantId, previousSlug: signed.slug });
  });

  it('annule aussi l’abonnement d’essai (même transaction) avec audit plateforme, sans relance ni facture', async () => {
    const signed = await signUp(app);
    const db = app.get(PlatformDb);
    const before = await db.run((tx) => tx.subscription.findUniqueOrThrow({ where: { tenantId: signed.tenantId } }));
    expect(before.status).toBe('trial');
    const later = new Date(Date.now() + 8 * DAY_MS);

    await job.runOnce(later, { tenantIds: [signed.tenantId] });

    const after = await db.run((tx) => tx.subscription.findUniqueOrThrow({ where: { tenantId: signed.tenantId } }));
    expect(after.status).toBe('cancelled');
    expect(after.statusChangedAt).toEqual(later);
    const audit = await db.run((tx) => tx.platformAuditLog.findMany({ where: { action: 'subscription.status_changed', tenantId: signed.tenantId } }));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.changes).toMatchObject({ from: 'trial', to: 'cancelled', reason: 'signup_expired' });
    const invoices = await db.run((tx) => tx.saasInvoice.count({ where: { tenantId: signed.tenantId } }));
    expect(invoices).toBe(0);
  });

  it('n’annule l’abonnement d’aucun tenant non expiré (actif ou confirmé)', async () => {
    const confirmed = await signUp(app);
    await postVerify(app, confirmed.token).expect(200);
    const fixture = await createTenantFixture(app);

    await job.runOnce(new Date(Date.now() + 30 * DAY_MS), { tenantIds: [confirmed.tenantId, fixture.tenantId] });

    const subs = await app.get(PlatformDb).run((tx) => tx.subscription.findMany({ where: { tenantId: { in: [confirmed.tenantId, fixture.tenantId] } } }));
    expect(subs.map((s) => s.status)).not.toContain('cancelled');
  });

  it('libère l’identifiant : une nouvelle inscription peut le réutiliser', async () => {
    const signed = await signUp(app);
    await job.runOnce(new Date(Date.now() + 8 * DAY_MS), { tenantIds: [signed.tenantId] });

    const again = await postSignup(app, signupInput(signed.slug)).expect(201);

    expect(again.body.data.tenantId).not.toBe(signed.tenantId);
  });

  it('refuse (410) le lien d’un tenant expiré', async () => {
    const signed = await signUp(app);
    await job.runOnce(new Date(Date.now() + 8 * DAY_MS), { tenantIds: [signed.tenantId] });

    await postVerify(app, signed.token).expect(410);
  });

  it('avant 7 jours : une inscription en attente n’est pas touchée', async () => {
    const signed = await signUp(app);

    const report = await job.runOnce(new Date(Date.now() + 6 * DAY_MS), { tenantIds: [signed.tenantId] });

    expect(report.expired).toBe(0);
    expect((await tenantRow(app, signed.tenantId)).status).toBe('pending');
  });

  it('un tenant confirmé entre-temps ou actif n’est jamais touché', async () => {
    const confirmed = await signUp(app);
    await postVerify(app, confirmed.token).expect(200);
    const fixture = await createTenantFixture(app);

    const report = await job.runOnce(new Date(Date.now() + 30 * DAY_MS), { tenantIds: [confirmed.tenantId, fixture.tenantId] });

    expect(report.expired).toBe(0);
    expect((await tenantRow(app, confirmed.tenantId)).status).toBe('active');
    expect((await tenantRow(app, fixture.tenantId)).status).toBe('active');
  });

  it('est idempotent : une seconde passe n’expire rien de plus', async () => {
    const signed = await signUp(app);
    const later = new Date(Date.now() + 8 * DAY_MS);

    await job.runOnce(later, { tenantIds: [signed.tenantId] });
    const second = await job.runOnce(later, { tenantIds: [signed.tenantId] });

    expect(second.expired).toBe(0);
  });

  it('purge les vérifications expirées depuis plus d’un jour, et seulement celles-là', async () => {
    const signed = await signUp(app);
    const db = app.get(TenantDb);

    const early = await job.runOnce(new Date(Date.now() + 1.5 * DAY_MS), { tenantIds: [signed.tenantId] });
    const rowsAfterEarly = await db.runAs(signed.tenantId, (tx) => tx.signupVerification.count());
    const late = await job.runOnce(new Date(Date.now() + 2.5 * DAY_MS), { tenantIds: [signed.tenantId] });
    const rowsAfterLate = await db.runAs(signed.tenantId, (tx) => tx.signupVerification.count());

    expect(early.purged).toBe(0);
    expect(rowsAfterEarly).toBe(1);
    expect(late.purged).toBe(1);
    expect(rowsAfterLate).toBe(0);
  });

  it('isole les tenants : la purge d’un établissement ne touche pas ceux d’un autre', async () => {
    const a = await signUp(app, uniqueSlug('iso-a'));
    const b = await signUp(app, uniqueSlug('iso-b'));

    await job.runOnce(new Date(Date.now() + 2.5 * DAY_MS), { tenantIds: [a.tenantId] });

    expect(await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.signupVerification.count())).toBe(0);
    expect(await app.get(TenantDb).runAs(b.tenantId, (tx) => tx.signupVerification.count())).toBe(1);
  });

  describe('tenant expiré : purge et anonymisation du fondateur (docs/11 §14.3.3)', () => {
    it('supprime tous les jetons de vérification du tenant expiré, même non échus (la purge d’un tenant expiré ne dépend pas du délai)', async () => {
      const signed = await signUp(app);
      const expiredAt = new Date(Date.now() + 8 * DAY_MS);

      await job.runOnce(expiredAt, { tenantIds: [signed.tenantId] });

      expect(await app.get(TenantDb).runAs(signed.tenantId, (tx) => tx.signupVerification.count())).toBe(0);
    });

    it('n’anonymise pas avant 30 jours après l’expiration', async () => {
      const signed = await signUp(app);
      const expiredAt = new Date(Date.now() + 8 * DAY_MS);
      await job.runOnce(expiredAt, { tenantIds: [signed.tenantId] });

      const report = await job.runOnce(new Date(expiredAt.getTime() + 29 * DAY_MS), { tenantIds: [signed.tenantId] });

      expect(report.anonymized).toBe(0);
      const user = await app.get(TenantDb).runAs(signed.tenantId, (tx) => tx.user.findFirstOrThrow());
      expect(user.email).toBe(signed.input.admin.email);
    });

    it('à +30 jours : nom et e-mail remplacés, mot de passe, sessions et facteurs supprimés, audit plateforme', async () => {
      const signed = await signUp(app);
      const db = app.get(TenantDb);
      const userId = await db.runAs(signed.tenantId, async (tx) => {
        const user = await tx.user.findFirstOrThrow({ select: { id: true } });
        await tx.session.create({ data: { tenantId: signed.tenantId, userId: user.id, expiresAt: new Date(Date.now() + DAY_MS) } });
        return user.id;
      });
      const expiredAt = new Date(Date.now() + 8 * DAY_MS);
      await job.runOnce(expiredAt, { tenantIds: [signed.tenantId] });

      const report = await job.runOnce(new Date(expiredAt.getTime() + 31 * DAY_MS), { tenantIds: [signed.tenantId] });

      expect(report).toMatchObject({ anonymized: 1, errors: 0 });
      const after = await db.runAs(signed.tenantId, async (tx) => ({
        user: await tx.user.findUniqueOrThrow({ where: { tenantId_id: { tenantId: signed.tenantId, id: userId } }, include: { credential: true } }),
        sessions: await tx.session.count(),
        factors: await tx.mfaFactor.count(),
      }));
      expect(after.user.fullName).toBe('Utilisateur supprimé');
      expect(after.user.email).toBe(`supprime-${userId}@anonymise.invalid`);
      expect(after.user.status).toBe('disabled');
      expect(after.user.credential).toBeNull();
      expect(after.sessions).toBe(0);
      expect(after.factors).toBe(0);
      const audit = await app.get(PlatformDb).run((tx) => tx.platformAuditLog.findMany({ where: { action: 'tenant.signup_anonymized', tenantId: signed.tenantId } }));
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorType: 'system', resourceId: signed.tenantId });
      expect(JSON.stringify(audit[0]!.changes)).not.toContain(signed.input.admin.email);
    });

    it('est idempotent : une seconde passe n’anonymise ni n’audite à nouveau', async () => {
      const signed = await signUp(app);
      const expiredAt = new Date(Date.now() + 8 * DAY_MS);
      const later = new Date(expiredAt.getTime() + 31 * DAY_MS);
      await job.runOnce(expiredAt, { tenantIds: [signed.tenantId] });
      await job.runOnce(later, { tenantIds: [signed.tenantId] });

      const second = await job.runOnce(later, { tenantIds: [signed.tenantId] });

      expect(second.anonymized).toBe(0);
      const audit = await app.get(PlatformDb).run((tx) => tx.platformAuditLog.count({ where: { action: 'tenant.signup_anonymized', tenantId: signed.tenantId } }));
      expect(audit).toBe(1);
    });

    it('ne touche ni un tenant actif ni un tenant confirmé, même 100 jours plus tard', async () => {
      const confirmed = await signUp(app);
      await postVerify(app, confirmed.token).expect(200);
      const fixture = await createTenantFixture(app);

      const report = await job.runOnce(new Date(Date.now() + 100 * DAY_MS), { tenantIds: [confirmed.tenantId, fixture.tenantId] });

      expect(report.anonymized).toBe(0);
      const user = await app.get(TenantDb).runAs(confirmed.tenantId, (tx) => tx.user.findFirstOrThrow());
      expect(user.email).toBe(confirmed.input.admin.email);
    });
  });
});
