import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Clock } from '../../src/common/time/clock';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createSite } from '../appointments/appointment-fixtures';
import { seedCatalog } from '../billing/billing-fixtures';
import { createTenantFixture, createUserWithPermissions, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { MutableClock } from '../helpers/mutable-clock';
import { createTestApp } from '../helpers/test-app';
import { bearer, DASHBOARD, http } from './admin-fixtures';
import {
  createPractitionerRow,
  createRegisterRow,
  insertAppointment,
  insertPatient,
  insertPayment,
  issuedInvoice,
  openSessionOk,
  payCash,
} from './dashboard-fixtures';

const UNKNOWN_ID = '018f0000-0000-7000-8000-000000000000';
const STATUSES = ['requested', 'scheduled', 'confirmed', 'checked_in', 'in_progress', 'completed', 'cancelled', 'no_show'];

/** Jour de référence : aujourd'hui (UTC), horloge figée à midi. Dakar est à UTC+0. */
const TODAY = new Date();
TODAY.setUTCHours(0, 0, 0, 0);
const at = (hour: number, minute = 0, dayOffset = 0): Date => new Date(TODAY.getTime() + dayOffset * 86_400_000 + hour * 3_600_000 + minute * 60_000);
const DATE_KEY = TODAY.toISOString().slice(0, 10);

interface DashboardBody {
  date: string;
  timezone: string;
  generatedAt: string;
  siteId: string | null;
  patients: { total: number; registeredToday: number } | null;
  appointments: { total: number; byStatus: Record<string, number> } | null;
  revenue: { currency: string; total: string; byMethod: Record<string, string> } | null;
  cashSessions: { openCount: number; items: { id: string; registerCode: string; siteId: string; openedAt: string; openedBy: { id: string; fullName: string } }[] } | null;
}

describe('GET /dashboards/establishment (HTTP)', () => {
  let app: INestApplication;
  let clock: MutableClock;
  let a: TenantFixture;
  let b: TenantFixture;
  let bare: TenantFixture;
  let secondSiteId: string;
  let doctor: UserFixture;
  let director: UserFixture;
  let accountant: UserFixture;
  let receptionist: UserFixture;
  let cashier: UserFixture;
  let siteCashier: UserFixture;
  let secondCashier: UserFixture;
  let registerCode: string;
  const patientLastName = 'Sow-Confidentiel';

  const get = (token: string, query: Record<string, string> = {}) => http(app).get(DASHBOARD).query(query).set(bearer({ token }));
  const dashboard = async (token: string, query: Record<string, string> = {}): Promise<DashboardBody> => (await get(token, query).expect(200)).body.data;

  beforeAll(async () => {
    clock = new MutableClock(at(12));
    app = await createTestApp({}, { providerOverrides: [{ token: Clock, useValue: clock }] });
    a = await createTenantFixture(app, { prefix: 'dash-a', optionalModules: ['appointments', 'billing', 'cashier'] });
    b = await createTenantFixture(app, { prefix: 'dash-b', optionalModules: ['appointments', 'billing', 'cashier'] });
    bare = await createTenantFixture(app, { prefix: 'dash-bare', optionalModules: [] });
    secondSiteId = await createSite(app, a, 'S2');
    doctor = await createUserWithRole(app, a, 'doctor');
    director = await createUserWithRole(app, a, 'director');
    accountant = await createUserWithRole(app, a, 'accountant');
    receptionist = await createUserWithRole(app, a, 'receptionist');
    cashier = await createUserWithRole(app, a, 'cashier');
    secondCashier = await createUserWithRole(app, a, 'cashier');
    siteCashier = await createUserWithPermissions(
      app,
      a,
      ['reports:dashboard:read', 'patients:patient:read', 'cashier:payment:read', 'cashier:cash_session:read', 'cashier:cash_session:create', 'billing:invoice:read'],
      { scopeType: 'site', scopeId: a.mainSiteId },
    );

    // Patients : 2 créés aujourd'hui (un par site), 1 sans site créé hier, 1 supprimé.
    const p1 = await insertPatient(app, a, { primarySiteId: a.mainSiteId, createdAt: at(8) });
    await insertPatient(app, a, { primarySiteId: secondSiteId, createdAt: at(9) });
    await insertPatient(app, a, { createdAt: at(10, 0, -1) });
    await insertPatient(app, a, { createdAt: at(8), deletedAt: at(9) });
    await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.patient.update({ where: { tenantId_id: { tenantId: a.tenantId, id: p1 } }, data: { lastName: patientLastName } }));

    // Rendez-vous : du jour (main : 2 scheduled, 1 confirmed, 1 cancelled ; S2 : 1 scheduled), hors jour, supprimé.
    const doctors = await Promise.all([1, 2, 3, 4, 5, 6, 7, 8].map(() => createPractitionerRow(app, a)));
    const appointment = (index: number, siteId: string, startsAt: Date, status: Parameters<typeof insertAppointment>[2]['status'], deletedAt?: Date) =>
      insertAppointment(app, a, { siteId, startsAt, status, patientId: p1, practitionerId: doctors[index]!, ...(deletedAt ? { deletedAt } : {}) });
    await appointment(0, a.mainSiteId, at(9), 'scheduled');
    await appointment(1, a.mainSiteId, at(9, 30), 'scheduled');
    await appointment(2, a.mainSiteId, at(23, 59), 'confirmed');
    await appointment(3, a.mainSiteId, at(11), 'cancelled');
    await appointment(4, secondSiteId, at(9), 'scheduled');
    await appointment(5, a.mainSiteId, at(0, 0, 1), 'scheduled'); // lendemain 00:00 : exclu
    await appointment(6, a.mainSiteId, at(23, 59, -1), 'scheduled'); // veille 23:59 : exclu
    await appointment(7, a.mainSiteId, at(13), 'scheduled', at(14)); // supprimé : exclu

    // Recettes : 3 000 espèces (session principale) ; 1 000 Mobile Money et 500 carte aujourd'hui ; hors jour ou non abouti : exclus.
    const catalog = await seedCatalog(app, a);
    const registerId = await createRegisterRow(app, a);
    const secondRegisterId = await createRegisterRow(app, a, secondSiteId);
    const session = await openSessionOk(app, cashier, registerId);
    await openSessionOk(app, secondCashier, secondRegisterId);
    const invoice = await issuedInvoice(app, receptionist, a, p1, catalog); // 8 500
    await payCash(app, cashier, invoice.id, '3000.00', session.id).expect(201);
    await insertPayment(app, a, { invoiceId: invoice.id, patientId: p1, method: 'mobile_money', amount: '1000.00', status: 'succeeded', paidAt: at(10) });
    await insertPayment(app, a, { invoiceId: invoice.id, patientId: p1, method: 'card', amount: '500.00', status: 'succeeded', paidAt: at(0, 0) });
    await insertPayment(app, a, { invoiceId: invoice.id, patientId: p1, method: 'other', amount: '200.00', status: 'succeeded', paidAt: at(23, 59) });
    await insertPayment(app, a, { invoiceId: invoice.id, patientId: p1, method: 'other', amount: '900.00', status: 'succeeded', paidAt: at(0, 0, 1) }); // lendemain : exclu
    await insertPayment(app, a, { invoiceId: invoice.id, patientId: p1, method: 'other', amount: '800.00', status: 'succeeded', paidAt: at(23, 59, -1) }); // veille : exclu
    await insertPayment(app, a, { invoiceId: invoice.id, patientId: p1, method: 'mobile_money', amount: '700.00', status: 'pending', paidAt: null });
    await insertPayment(app, a, { invoiceId: invoice.id, patientId: p1, method: 'mobile_money', amount: '600.00', status: 'failed', paidAt: null });
    const secondRegister = await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.cashRegister.findFirstOrThrow({ where: { id: secondRegisterId } }));
    registerCode = secondRegister.code;
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('autorisation, validation et sections', () => {
    it('exige l’authentification (401) et refuse sans reports:dashboard:read (403)', async () => {
      await http(app).get(DASHBOARD).expect(401);
      await get(receptionist.token).expect(403);
    });

    it('rejette un siteId mal formé (422) et un siteId inconnu ou d’un autre établissement (422 not_found)', async () => {
      await get(a.adminToken, { siteId: 'abc' }).expect(422);
      const unknown = await get(a.adminToken, { siteId: UNKNOWN_ID }).expect(422);
      const foreign = await get(a.adminToken, { siteId: b.mainSiteId }).expect(422);

      for (const res of [unknown, foreign]) {
        expect(res.body.errors).toEqual([expect.objectContaining({ path: 'siteId', code: 'not_found' })]);
      }
    });

    it('administrateur : patients et rendez-vous (agenda) seulement ; recettes et caisses à null faute de permission', async () => {
      const body = await dashboard(a.adminToken);

      expect(body.patients).not.toBeNull();
      expect(body.appointments).not.toBeNull();
      expect(body.revenue).toBeNull();
      expect(body.cashSessions).toBeNull();
    });

    it('médecin : patients et rendez-vous ; pas de recettes ni de caisses', async () => {
      const body = await dashboard(doctor.token);

      expect([body.patients !== null, body.appointments !== null, body.revenue === null, body.cashSessions === null]).toEqual([true, true, true, true]);
    });

    it('comptable : patients, recettes et caisses ; pas de rendez-vous (aucune permission de rendez-vous)', async () => {
      const body = await dashboard(accountant.token);

      expect([body.patients !== null, body.appointments === null, body.revenue !== null, body.cashSessions !== null]).toEqual([true, true, true, true]);
    });

    it('directeur : recettes (billing:invoice:read) mais ni rendez-vous ni caisses ni patients', async () => {
      const body = await dashboard(director.token);

      expect([body.patients, body.appointments, body.cashSessions]).toEqual([null, null, null]);
      expect(body.revenue).not.toBeNull();
    });

    it('établissement sans modules optionnels : sections rendez-vous, recettes et caisses à null malgré la permission', async () => {
      const body = await dashboard(bare.adminToken);

      expect(body.patients).toEqual({ total: 0, registeredToday: 0 });
      expect([body.appointments, body.revenue, body.cashSessions]).toEqual([null, null, null]);
    });
  });

  describe('comptes de l’établissement', () => {
    it('renvoie la date et le fuseau du tenant, l’instant de génération et siteId null', async () => {
      const body = await dashboard(accountant.token);

      expect(body).toMatchObject({ date: DATE_KEY, timezone: 'Africa/Dakar', siteId: null, generatedAt: at(12).toISOString() });
    });

    it('compte les patients non supprimés et ceux enregistrés aujourd’hui', async () => {
      const body = await dashboard(a.adminToken);

      expect(body.patients).toEqual({ total: 3, registeredToday: 2 });
    });

    it('compte les rendez-vous du jour non supprimés, par statut, avec les 8 clés (zéros compris)', async () => {
      const body = await dashboard(a.adminToken);

      expect(Object.keys(body.appointments!.byStatus).sort()).toEqual([...STATUSES].sort());
      expect(body.appointments).toEqual({
        total: 5,
        byStatus: { requested: 0, scheduled: 3, confirmed: 1, checked_in: 0, in_progress: 0, completed: 0, cancelled: 1, no_show: 0 },
      });
    });

    it('respecte les bornes du jour : 23:59 inclus, 00:00 du lendemain et 23:59 de la veille exclus', async () => {
      const body = await dashboard(a.adminToken, { siteId: a.mainSiteId });

      expect(body.appointments!.byStatus.confirmed).toBe(1);
      expect(body.appointments!.total).toBe(4);
    });

    it('somme les recettes du jour par mode : succeeded seulement, hors jour, en attente et échecs exclus', async () => {
      const body = await dashboard(accountant.token);

      expect(body.revenue).toEqual({
        currency: 'XOF',
        total: '4700.00',
        byMethod: { cash: '3000.00', mobile_money: '1000.00', card: '500.00', other: '200.00' },
      });
    });

    it('liste les sessions de caisse ouvertes avec leur ouvreur (identité du personnel)', async () => {
      const body = await dashboard(accountant.token);

      expect(body.cashSessions!.openCount).toBe(2);
      expect(body.cashSessions!.items).toHaveLength(2);
      expect(body.cashSessions!.items.find((item) => item.siteId === a.mainSiteId)).toMatchObject({
        id: expect.any(String),
        registerCode: expect.any(String),
        openedAt: expect.stringMatching(/Z$/),
        openedBy: { id: cashier.userId, fullName: 'Utilisateur cashier' },
      });
      expect(body.cashSessions!.items.find((item) => item.siteId === secondSiteId)?.registerCode).toBe(registerCode);
    });
  });

  describe('filtre par site et portée', () => {
    it('restreint toutes les sections au site demandé', async () => {
      const body = await dashboard(accountant.token, { siteId: secondSiteId });

      expect(body.siteId).toBe(secondSiteId);
      expect(body.patients).toEqual({ total: 1, registeredToday: 1 });
      expect(body.revenue!.total).toBe('0.00');
      expect(body.cashSessions!.openCount).toBe(1);
      expect((await dashboard(a.adminToken, { siteId: secondSiteId })).appointments!.total).toBe(1);
    });

    it('caissier limité à son site : aucune donnée de l’autre site (patients, recettes, sessions)', async () => {
      const body = await dashboard(siteCashier.token);

      expect(body.appointments).toBeNull();
      expect(body.cashSessions).toMatchObject({ openCount: 1 });
      expect(body.cashSessions!.items.every((item) => item.siteId === a.mainSiteId)).toBe(true);
      expect(body.revenue!.byMethod.cash).toBe('3000.00');
      expect(body.patients!.total).toBe(2); // site principal + patient sans site, pas celui du site 2
    });

    it('caissier limité : un siteId hors de sa portée ne révèle rien (sections vides)', async () => {
      const body = await dashboard(siteCashier.token, { siteId: secondSiteId });

      expect(body.cashSessions).toMatchObject({ openCount: 0, items: [] });
      expect(body.revenue!.total).toBe('0.00');
      expect(body.patients!.total).toBe(0);
    });
  });

  describe('isolation et confidentialité', () => {
    it('ne compte rien d’un autre établissement', async () => {
      const body = await dashboard(b.adminToken);

      expect(body.patients).toEqual({ total: 0, registeredToday: 0 });
      expect(body.appointments!.total).toBe(0);
    });

    it('ne contient aucune donnée nominative de patient', async () => {
      const raw = JSON.stringify((await get(accountant.token).expect(200)).body) + JSON.stringify((await get(a.adminToken).expect(200)).body);

      expect(raw).not.toContain(patientLastName);
    });
  });

  describe('bornes du jour dans le fuseau du tenant', () => {
    it('Africa/Douala (UTC+1) : le jour local commence à 23:00 UTC la veille', async () => {
      await app.get(PlatformDb).run((tx) => tx.tenant.update({ where: { id: a.tenantId }, data: { timezone: 'Africa/Douala' } }));
      try {
        clock.set(at(23, 30)); // 00:30 locale le lendemain : le « jour » est déjà demain
        const body = await dashboard(a.adminToken);

        const tomorrow = new Date(TODAY.getTime() + 86_400_000).toISOString().slice(0, 10);
        expect(body.date).toBe(tomorrow);
        expect(body.timezone).toBe('Africa/Douala');
        // Jour local = [today 23:00Z ; tomorrow 23:00Z[ : contient les 23:59 d'aujourd'hui et le 00:00 de demain, pas les 09:00 d'aujourd'hui.
        expect(body.appointments!.total).toBe(2);
      } finally {
        clock.set(at(12));
        await app.get(PlatformDb).run((tx) => tx.tenant.update({ where: { id: a.tenantId }, data: { timezone: 'Africa/Dakar' } }));
      }
    });
  });
});
