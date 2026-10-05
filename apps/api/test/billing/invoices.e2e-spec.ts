import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createDepartmentRow, createPatientRow, createSite } from '../appointments/appointment-fixtures';
import { createUserWithPermissions, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import {
  BILLING,
  UNKNOWN_ID,
  auditActions,
  bearer,
  createBillingTenant,
  createInvoice,
  draftInvoice,
  getInvoice,
  http,
  issueInvoice,
  seedCatalog,
  type Catalog,
} from './billing-fixtures';

describe('factures patient (HTTP)', () => {
  let app: INestApplication;
  let a: TenantFixture;
  let b: TenantFixture;
  let catalogA: Catalog;
  let catalogB: Catalog;
  let patientId: string;
  let receptionist: UserFixture;
  let adminAgent: UserFixture;
  let accountant: UserFixture;
  let cashier: UserFixture;
  let otherCashier: UserFixture;
  let doctor: UserFixture;

  beforeAll(async () => {
    app = await createTestApp();
    [a, b] = await Promise.all([createBillingTenant(app, 'inv-a'), createBillingTenant(app, 'inv-b')]);
    [catalogA, catalogB] = await Promise.all([seedCatalog(app, a), seedCatalog(app, b)]);
    patientId = await createPatientRow(app, a);
    receptionist = await createUserWithRole(app, a, 'receptionist');
    adminAgent = await createUserWithRole(app, a, 'admin_agent');
    accountant = await createUserWithRole(app, a, 'accountant');
    cashier = await createUserWithRole(app, a, 'cashier');
    doctor = await createUserWithRole(app, a, 'doctor');
    otherCashier = await createUserWithRole(app, b, 'cashier');
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('création du brouillon', () => {
    it('crée une facture depuis la grille avec des totaux calculés côté serveur (chaînes décimales)', async () => {
      const invoice = await draftInvoice(app, receptionist, a, patientId, catalogA, [
        { priceListItemId: catalogA.consultation.id },
        { priceListItemId: catalogA.exam.id, quantity: '2' },
        { priceListItemId: catalogA.drug.id, quantity: '3' },
      ]);

      expect(invoice).toMatchObject({ status: 'draft', number: null, currency: 'XOF', subtotal: '12450.00', total: '12450.00', amountPaid: '0.00', balance: '12450.00' });
      expect(invoice.lines.map((l) => l.lineTotal)).toEqual(['5000.00', '7000.00', '450.00']);
      expect(invoice.lines[0]).toMatchObject({ lineNo: 1, description: 'Consultation générale', category: 'consultation', unitPrice: '5000.00', quantity: '1' });
      expect(invoice).toMatchObject({ patientId, siteId: a.mainSiteId, patient: { id: patientId } });
    });

    it('fige le prix de la grille dans la ligne : une hausse ultérieure ne modifie pas la facture', async () => {
      const own = await seedCatalog(app, a);
      const invoice = await draftInvoice(app, receptionist, a, patientId, own, [{ priceListItemId: own.consultation.id }]);
      await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.priceListItem.update({ where: { tenantId_id: { tenantId: a.tenantId, id: own.consultation.id } }, data: { unitPrice: '9999.00' } }));

      expect((await getInvoice(app, receptionist, invoice.id)).total).toBe('5000.00');
    });

    it('ne fait aucune confiance au client pour les montants (champs de total ignorés)', async () => {
      const res = await createInvoice(app, receptionist, {
        patientId,
        siteId: a.mainSiteId,
        total: '1.00',
        lines: [{ priceListItemId: catalogA.consultation.id, total: '1.00', unitPrice: '1.00' }],
      }).expect(201);

      expect(res.body.data.total).toBe('5000.00');
    });

    it('accepte une ligne libre pour un détenteur de billing:invoice:update et la refuse (403) sinon', async () => {
      const free = { description: 'Pansement complexe', category: 'acte', unitPrice: '1500.00', quantity: '2' };

      const ok = await createInvoice(app, adminAgent, { patientId, siteId: a.mainSiteId, lines: [free] }).expect(201);
      const denied = await createInvoice(app, receptionist, { patientId, siteId: a.mainSiteId, lines: [free] }).expect(403);

      expect(ok.body.data).toMatchObject({ total: '3000.00' });
      expect(ok.body.data.lines[0]).toMatchObject({ priceListItemId: null, description: 'Pansement complexe' });
      expect(denied.body.code).toBe('free_line_forbidden');
    });

    it('lie la facture à un rendez-vous du même patient et refuse un rendez-vous d’un autre patient ou inconnu (422)', async () => {
      const otherPatient = await createPatientRow(app, a);
      const practitioner = await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.practitioner.create({ data: { tenantId: a.tenantId, fullName: 'Dr Test' }, select: { id: true } }));
      const appointment = await app.get(TenantDb).runAs(a.tenantId, (tx) =>
        tx.appointment.create({
          data: { tenantId: a.tenantId, patientId, practitionerId: practitioner.id, siteId: a.mainSiteId, startsAt: new Date('2027-01-05T09:00:00Z'), endsAt: new Date('2027-01-05T09:20:00Z') },
          select: { id: true },
        }),
      );
      const lines = [{ priceListItemId: catalogA.consultation.id }];

      const ok = await createInvoice(app, receptionist, { patientId, siteId: a.mainSiteId, appointmentId: appointment.id, lines }).expect(201);
      await createInvoice(app, receptionist, { patientId: otherPatient, siteId: a.mainSiteId, appointmentId: appointment.id, lines }).expect(422);
      await createInvoice(app, receptionist, { patientId, siteId: a.mainSiteId, appointmentId: UNKNOWN_ID, lines }).expect(422);

      expect(ok.body.data.appointmentId).toBe(appointment.id);
    });

    it('refuse (422) un article inactif, d’une grille inactive ou dans une autre devise', async () => {
      const own = await seedCatalog(app, a);
      await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.priceListItem.update({ where: { tenantId_id: { tenantId: a.tenantId, id: own.drug.id } }, data: { isActive: false } }));
      const eur = await seedCatalog(app, a);
      await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.priceList.update({ where: { tenantId_id: { tenantId: a.tenantId, id: eur.priceListId } }, data: { currency: 'EUR', isDefault: false } }));
      const archived = await seedCatalog(app, a);
      await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.priceList.update({ where: { tenantId_id: { tenantId: a.tenantId, id: archived.priceListId } }, data: { isActive: false, isDefault: false } }));

      for (const item of [own.drug, eur.consultation, archived.consultation]) {
        const res = await createInvoice(app, receptionist, { patientId, siteId: a.mainSiteId, lines: [{ priceListItemId: item.id }] }).expect(422);
        expect(res.body.errors[0].path).toBe('lines.0.priceListItemId');
      }
    });

    it('valide le corps (422) : sans ligne, quantité nulle, prix flottant, identifiants invalides', async () => {
      const base = { patientId, siteId: a.mainSiteId };

      await createInvoice(app, receptionist, { ...base, lines: [] }).expect(422);
      await createInvoice(app, receptionist, { ...base, lines: [{ priceListItemId: catalogA.drug.id, quantity: '0' }] }).expect(422);
      await createInvoice(app, adminAgent, { ...base, lines: [{ description: 'Libre', category: 'acte', unitPrice: 15.5 }] }).expect(422);
      await createInvoice(app, receptionist, { patientId: 'pas-un-uuid', siteId: a.mainSiteId, lines: [{ priceListItemId: catalogA.drug.id }] }).expect(422);
    });

    it('404 pour un patient inconnu ou d’un autre établissement, 422 pour un site ou un article étrangers', async () => {
      const foreignPatient = await createPatientRow(app, b);
      const lines = [{ priceListItemId: catalogA.drug.id }];

      await createInvoice(app, receptionist, { patientId: UNKNOWN_ID, siteId: a.mainSiteId, lines }).expect(404);
      await createInvoice(app, receptionist, { patientId: foreignPatient, siteId: a.mainSiteId, lines }).expect(404);
      await createInvoice(app, receptionist, { patientId, siteId: b.mainSiteId, lines }).expect(422);
      await createInvoice(app, receptionist, { patientId, siteId: a.mainSiteId, lines: [{ priceListItemId: catalogB.drug.id }] }).expect(422);
    });

    it('refuse sans permission (403) et sans jeton (401)', async () => {
      const body = { patientId, siteId: a.mainSiteId, lines: [{ priceListItemId: catalogA.drug.id }] };

      await createInvoice(app, doctor, body).expect(403);
      await http(app).post(`${BILLING}/invoices`).send(body).expect(401);
    });

    it('audite la création avec identifiants et montants seulement', async () => {
      const invoice = await draftInvoice(app, receptionist, a, patientId, catalogA);

      const [entry] = await auditActions(app, a, 'invoice.created', invoice.id);

      expect(entry).toMatchObject({ resourceType: 'invoice', patientId, actorUserId: receptionist.userId });
      expect(entry?.changes).toMatchObject({ total: '8500.00', lineCount: 2, currency: 'XOF' });
    });
  });

  describe('modification du brouillon (PUT /lines)', () => {
    it('remplace les lignes et recalcule les totaux', async () => {
      const draft = await draftInvoice(app, receptionist, a, patientId, catalogA);

      const res = await http(app)
        .put(`${BILLING}/invoices/${draft.id}/lines`)
        .set(bearer(receptionist))
        .send({ lines: [{ priceListItemId: catalogA.drug.id, quantity: '4' }] })
        .expect(200);

      expect(res.body.data).toMatchObject({ total: '600.00', balance: '600.00' });
      expect(res.body.data.lines).toHaveLength(1);
      expect(res.body.data.lines[0].lineNo).toBe(1);
    });

    it('refuse (409) après émission et (422) un remplacement vide', async () => {
      const draft = await draftInvoice(app, receptionist, a, patientId, catalogA);
      await http(app).put(`${BILLING}/invoices/${draft.id}/lines`).set(bearer(receptionist)).send({ lines: [] }).expect(422);
      await issueInvoice(app, receptionist, draft.id);

      const res = await http(app).put(`${BILLING}/invoices/${draft.id}/lines`).set(bearer(receptionist)).send({ lines: [{ priceListItemId: catalogA.drug.id }] }).expect(409);

      expect(res.body.code).toBe('invoice_not_draft');
    });

    it('applique la règle des lignes libres et 404 hors établissement', async () => {
      const draft = await draftInvoice(app, receptionist, a, patientId, catalogA);
      const free = { lines: [{ description: 'Libre', category: 'autre', unitPrice: '10.00' }] };

      await http(app).put(`${BILLING}/invoices/${draft.id}/lines`).set(bearer(receptionist)).send(free).expect(403);
      await http(app).put(`${BILLING}/invoices/${draft.id}/lines`).set(bearer(adminAgent)).send(free).expect(200);
      await http(app).put(`${BILLING}/invoices/${draft.id}/lines`).set(bearer(otherCashier)).send(free).expect(404);
    });
  });

  describe('émission', () => {
    it('attribue un numéro FAC-AAAA-NNNNNN, passe en « issued » et fige la date d’émission', async () => {
      const draft = await draftInvoice(app, receptionist, a, patientId, catalogA);

      const issued = await issueInvoice(app, receptionist, draft.id);

      expect(issued.status).toBe('issued');
      expect(issued.number).toMatch(/^FAC-\d{4}-\d{6}$/);
      expect(issued.issuedAt).not.toBeNull();
      const [entry] = await auditActions(app, a, 'invoice.issued', draft.id);
      expect(entry?.changes).toMatchObject({ number: issued.number, total: '8500.00' });
    });

    it('refuse une seconde émission (409) sans consommer de numéro', async () => {
      const issued = await issueInvoice(app, receptionist, (await draftInvoice(app, receptionist, a, patientId, catalogA)).id);

      const again = await http(app).post(`${BILLING}/invoices/${issued.id}/issue`).set(bearer(receptionist)).expect(409);

      expect(again.body.code).toBe('invoice_not_draft');
      expect((await getInvoice(app, receptionist, issued.id)).number).toBe(issued.number);
    });

    it('émet une facture à total nul directement soldée', async () => {
      const draft = await draftInvoice(app, adminAgent, a, patientId, catalogA, [{ description: 'Geste commercial', category: 'autre', unitPrice: '0.00' }]);

      const issued = await issueInvoice(app, adminAgent, draft.id);

      expect(issued).toMatchObject({ status: 'paid', total: '0.00', balance: '0.00' });
    });

    it('404 hors établissement ou inconnue, 403 sans permission', async () => {
      const draft = await draftInvoice(app, receptionist, a, patientId, catalogA);

      await http(app).post(`${BILLING}/invoices/${draft.id}/issue`).set(bearer(otherCashier)).expect(404);
      await http(app).post(`${BILLING}/invoices/${UNKNOWN_ID}/issue`).set(bearer(receptionist)).expect(404);
      await http(app).post(`${BILLING}/invoices/${draft.id}/issue`).set(bearer(doctor)).expect(403);
    });
  });

  describe('immutabilité d’une facture émise', () => {
    it('refuse en base toute modification des montants, des lignes et la suppression, même hors API', async () => {
      const issued = await issueInvoice(app, receptionist, (await draftInvoice(app, receptionist, a, patientId, catalogA)).id);
      const tenantDb = app.get(TenantDb);

      await expect(tenantDb.runAs(a.tenantId, (tx) => tx.$executeRaw`UPDATE tenant.invoices SET total = 1, subtotal = 1 WHERE id = ${issued.id}::uuid`)).rejects.toThrow();
      await expect(tenantDb.runAs(a.tenantId, (tx) => tx.$executeRaw`UPDATE tenant.invoices SET number = 'FAC-2026-999999' WHERE id = ${issued.id}::uuid`)).rejects.toThrow();
      await expect(tenantDb.runAs(a.tenantId, (tx) => tx.$executeRaw`UPDATE tenant.invoice_lines SET unit_price = 1, line_total = 1 WHERE invoice_id = ${issued.id}::uuid`)).rejects.toThrow();
      await expect(tenantDb.runAs(a.tenantId, (tx) => tx.$executeRaw`DELETE FROM tenant.invoice_lines WHERE invoice_id = ${issued.id}::uuid`)).rejects.toThrow();
      await expect(tenantDb.runAs(a.tenantId, (tx) => tx.$executeRaw`DELETE FROM tenant.invoices WHERE id = ${issued.id}::uuid`)).rejects.toThrow();
      expect((await getInvoice(app, receptionist, issued.id)).total).toBe('8500.00');
    });
  });

  describe('annulation', () => {
    it('annule une facture émise sans paiement avec un motif, conserve le numéro et audite', async () => {
      const issued = await issueInvoice(app, receptionist, (await draftInvoice(app, receptionist, a, patientId, catalogA)).id);

      const res = await http(app).post(`${BILLING}/invoices/${issued.id}/void`).set(bearer(accountant)).send({ reasonCode: 'other', comment: 'Erreur de saisie du patient' }).expect(200);

      expect(res.body.data).toMatchObject({ status: 'void', number: issued.number, voidReasonCode: 'other', voidReason: 'Erreur de saisie du patient' });
      expect(res.body.data.voidedAt).not.toBeNull();
      const [entry] = await auditActions(app, a, 'invoice.voided', issued.id);
      expect(entry?.changes).toEqual(expect.objectContaining({ number: issued.number, reasonCode: 'other' }));
      expect(JSON.stringify(entry?.changes)).not.toContain('Erreur de saisie');
    });

    it('annule un brouillon (sans numéro) et refuse ensuite toute émission', async () => {
      const draft = await draftInvoice(app, receptionist, a, patientId, catalogA);

      await http(app).post(`${BILLING}/invoices/${draft.id}/void`).set(bearer(accountant)).send({ reasonCode: 'other', comment: 'Brouillon abandonné' }).expect(200);

      const res = await http(app).post(`${BILLING}/invoices/${draft.id}/issue`).set(bearer(receptionist)).expect(409);
      expect(res.body.code).toBe('invoice_not_draft');
    });

    it('exige un motif (422), refuse une double annulation (409) et sans permission validate (403)', async () => {
      const issued = await issueInvoice(app, receptionist, (await draftInvoice(app, receptionist, a, patientId, catalogA)).id);

      await http(app).post(`${BILLING}/invoices/${issued.id}/void`).set(bearer(accountant)).send({}).expect(422);
      await http(app).post(`${BILLING}/invoices/${issued.id}/void`).set(bearer(receptionist)).send({ reasonCode: 'other', comment: 'Je ne peux pas' }).expect(403);
      await http(app).post(`${BILLING}/invoices/${issued.id}/void`).set(bearer(accountant)).send({ reasonCode: 'other', comment: 'Premier motif' }).expect(200);
      const twice = await http(app).post(`${BILLING}/invoices/${issued.id}/void`).set(bearer(accountant)).send({ reasonCode: 'other', comment: 'Second motif' }).expect(409);
      expect(twice.body.code).toBe('invoice_already_void');
    });

    it('404 hors établissement', async () => {
      const issued = await issueInvoice(app, receptionist, (await draftInvoice(app, receptionist, a, patientId, catalogA)).id);
      const foreignAccountant = await createUserWithRole(app, b, 'accountant');

      await http(app).post(`${BILLING}/invoices/${issued.id}/void`).set(bearer(foreignAccountant)).send({ reasonCode: 'other', comment: 'Tentative' }).expect(404);
    });
  });

  describe('lecture, liste et reçu', () => {
    it('relit le détail (lignes, paiements, patient) et audite la lecture avec le patient', async () => {
      const issued = await issueInvoice(app, receptionist, (await draftInvoice(app, receptionist, a, patientId, catalogA)).id);

      const detail = await getInvoice(app, cashier, issued.id);

      expect(detail).toMatchObject({ id: issued.id, number: issued.number, payments: [], lines: expect.any(Array) });
      const entries = await auditActions(app, a, 'invoice.read', issued.id);
      expect(entries.length).toBeGreaterThanOrEqual(1);
      expect(entries[0]).toMatchObject({ patientId });
    });

    it('ne divulgue aucune donnée de contact du patient (identité administrative seulement)', async () => {
      const issued = await issueInvoice(app, receptionist, (await draftInvoice(app, receptionist, a, patientId, catalogA)).id);

      const detail = await getInvoice(app, cashier, issued.id);

      expect(Object.keys(detail['patient'] as object).sort()).toEqual(['fullName', 'id', 'identityMasked', 'ipp']);
    });

    it('404 pour une facture inconnue, mal formée ou d’un autre établissement', async () => {
      const theirs = await draftInvoice(app, otherCashier, b, await createPatientRow(app, b), catalogB);

      await http(app).get(`${BILLING}/invoices/${UNKNOWN_ID}`).set(bearer(cashier)).expect(404);
      await http(app).get(`${BILLING}/invoices/pas-un-uuid`).set(bearer(cashier)).expect(404);
      await http(app).get(`${BILLING}/invoices/${theirs.id}`).set(bearer(cashier)).expect(404);
    });

    it('liste filtrée par statut et patient, avec pagination par curseur et sans fuite entre établissements', async () => {
      const own = await createPatientRow(app, a);
      const first = await draftInvoice(app, receptionist, a, own, catalogA);
      const second = await issueInvoice(app, receptionist, (await draftInvoice(app, receptionist, a, own, catalogA)).id);
      await draftInvoice(app, receptionist, a, own, catalogA);

      const all = await http(app).get(`${BILLING}/invoices?patientId=${own}`).set(bearer(cashier)).expect(200);
      const issued = await http(app).get(`${BILLING}/invoices?patientId=${own}&status=issued`).set(bearer(cashier)).expect(200);
      const page1 = await http(app).get(`${BILLING}/invoices?patientId=${own}&limit=2`).set(bearer(cashier)).expect(200);
      const page2 = await http(app).get(`${BILLING}/invoices?patientId=${own}&limit=2&cursor=${page1.body.meta.pagination.nextCursor}`).set(bearer(cashier)).expect(200);

      expect(all.body.data).toHaveLength(3);
      expect(issued.body.data.map((i: { id: string }) => i.id)).toEqual([second.id]);
      expect(page1.body.meta.pagination.hasMore).toBe(true);
      expect(page2.body.data).toHaveLength(1);
      const ids = [...page1.body.data, ...page2.body.data].map((i: { id: string }) => i.id);
      expect(new Set(ids).size).toBe(3);
      expect(ids).toContain(first.id);
      expect(all.body.data[0]).not.toHaveProperty('lines');
      const foreign = await http(app).get(`${BILLING}/invoices`).set(bearer(otherCashier)).expect(200);
      expect(foreign.body.data.every((i: { id: string }) => !ids.includes(i.id))).toBe(true);
      await http(app).get(`${BILLING}/invoices?cursor=!!`).set(bearer(cashier)).expect(422);
      await http(app).get(`${BILLING}/invoices?status=inconnu`).set(bearer(cashier)).expect(422);
    });

    it('sert un reçu imprimable avec établissement, site et facture ; refuse sans billing:invoice:print', async () => {
      const issued = await issueInvoice(app, receptionist, (await draftInvoice(app, receptionist, a, patientId, catalogA)).id);
      const noPrint = await createUserWithPermissions(app, a, ['billing:invoice:read']);

      const res = await http(app).get(`${BILLING}/invoices/${issued.id}/receipt`).set(bearer(cashier)).expect(200);

      expect(res.body.data).toMatchObject({ establishment: expect.stringContaining('Clinique'), site: 'Site principal', invoice: { id: issued.id, number: issued.number } });
      expect(res.body.data.printedAt).toEqual(expect.any(String));
      await http(app).get(`${BILLING}/invoices/${issued.id}/receipt`).set(bearer(noPrint)).expect(403);
      expect((await auditActions(app, a, 'invoice.printed', issued.id)).length).toBe(1);
    });
  });

  describe('périmètre (sites et patients)', () => {
    it('un utilisateur limité à un site ne crée, ne voit et n’émet que pour son site', async () => {
      const siteB = await createSite(app, a, 'SITE-FAC-B');
      const scoped = await createUserWithRole(app, a, 'receptionist', { scopeType: 'site', scopeId: siteB });
      const lines = [{ priceListItemId: catalogA.drug.id }];
      const onMain = await draftInvoice(app, receptionist, a, patientId, catalogA);

      await createInvoice(app, scoped, { patientId, siteId: a.mainSiteId, lines }).expect(403);
      const own = await createInvoice(app, scoped, { patientId, siteId: siteB, lines }).expect(201);
      await http(app).get(`${BILLING}/invoices/${onMain.id}`).set(bearer(scoped)).expect(404);
      await http(app).post(`${BILLING}/invoices/${onMain.id}/issue`).set(bearer(scoped)).expect(404);
      const list = await http(app).get(`${BILLING}/invoices?limit=100`).set(bearer(scoped)).expect(200);
      expect(list.body.data.map((i: { id: string }) => i.id)).toContain(own.body.data.id);
      expect(list.body.data.every((i: { siteId: string }) => i.siteId === siteB)).toBe(true);
      await http(app).get(`${BILLING}/invoices/${own.body.data.id}`).set(bearer(scoped)).expect(200);
    });

    it('un patient rattaché à un autre site est introuvable pour un utilisateur limité à un site', async () => {
      const siteB = await createSite(app, a, 'SITE-FAC-C');
      const patientOnMain = await createPatientRow(app, a, { primarySiteId: a.mainSiteId });
      const scoped = await createUserWithRole(app, a, 'receptionist', { scopeType: 'site', scopeId: siteB });

      await createInvoice(app, scoped, { patientId: patientOnMain, siteId: siteB, lines: [{ priceListItemId: catalogA.drug.id }] }).expect(404);
    });

    it('la portée « service » couvre les sites du service', async () => {
      const siteD = await createSite(app, a, 'SITE-FAC-D');
      const department = await createDepartmentRow(app, a, siteD);
      const scoped = await createUserWithRole(app, a, 'receptionist', { scopeType: 'department', scopeId: department });

      await createInvoice(app, scoped, { patientId, siteId: siteD, lines: [{ priceListItemId: catalogA.drug.id }] }).expect(201);
      await createInvoice(app, scoped, { patientId, siteId: a.mainSiteId, lines: [{ priceListItemId: catalogA.drug.id }] }).expect(403);
    });
  });
});
