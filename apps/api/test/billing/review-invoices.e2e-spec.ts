import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createPatientRow, createSite } from '../appointments/appointment-fixtures';
import { createUserWithPermissions, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import {
  BILLING,
  auditActions,
  bearer,
  createBillingTenant,
  createInvoice,
  createRegisterRow,
  draftInvoice,
  getInvoice,
  http,
  issueInvoice,
  issuedInvoice,
  openSessionOk,
  payCash,
  seedCatalog,
  type Catalog,
} from './billing-fixtures';

type LineBody = { description: string; labelMasked: boolean; isSensitive: boolean; lineTotal: string; quantity: string };

describe('facturation : correctifs de la revue santé (R2, R3, R5, R6, R7, R9)', () => {
  let app: INestApplication;
  let tenant: TenantFixture;
  let catalog: Catalog;
  let patientId: string;
  let sensitiveItemId: string;
  let neutralItemId: string;
  let receptionist: UserFixture;
  let cashier: UserFixture;
  let accountant: UserFixture;
  let director: UserFixture;
  let clinical: UserFixture;
  let adminAgent: UserFixture;

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await createBillingTenant(app, 'rev');
    catalog = await seedCatalog(app, tenant);
    patientId = await createPatientRow(app, tenant);
    [receptionist, cashier, accountant, director, adminAgent] = await Promise.all([
      createUserWithRole(app, tenant, 'receptionist'),
      createUserWithRole(app, tenant, 'cashier'),
      createUserWithRole(app, tenant, 'accountant'),
      createUserWithRole(app, tenant, 'director'),
      createUserWithRole(app, tenant, 'admin_agent'),
    ]);
    clinical = await createUserWithPermissions(app, tenant, ['billing:invoice:read', 'billing:invoice:print', 'consultations:consultation:read', 'patients:patient:read']);
    const created = await app.get(TenantDb).runAs(tenant.tenantId, async (tx) => {
      const sensitive = await tx.priceListItem.create({
        data: { tenantId: tenant.tenantId, priceListId: catalog.priceListId, code: `VIH-${randomBytes(2).toString('hex')}`, label: 'Dépistage VIH', category: 'examen', unitPrice: '2000.00', isSensitive: true, printLabel: 'Examen biologique' },
        select: { id: true },
      });
      const neutral = await tx.priceListItem.create({
        data: { tenantId: tenant.tenantId, priceListId: catalog.priceListId, code: `PSY-${randomBytes(2).toString('hex')}`, label: 'Consultation psychiatrique', category: 'consultation', unitPrice: '6000.00', isSensitive: true },
        select: { id: true },
      });
      return { sensitive: sensitive.id, neutral: neutral.id };
    });
    sensitiveItemId = created.sensitive;
    neutralItemId = created.neutral;
  });

  afterAll(async () => {
    await app?.close();
  });

  const sensitiveInvoice = () =>
    issuedInvoice(app, receptionist, tenant, patientId, catalog, [{ priceListItemId: sensitiveItemId }, { priceListItemId: neutralItemId }, { priceListItemId: catalog.drug.id }]);
  const linesOf = (body: unknown): LineBody[] => (body as { lines: LineBody[] }).lines;

  describe('R2 : libellés sensibles', () => {
    it('masque la ligne sensible pour le caissier, le comptable et le directeur (libellé d’impression ou libellé neutre)', async () => {
      const invoice = await sensitiveInvoice();

      for (const user of [cashier, accountant, director]) {
        const lines = linesOf(await getInvoice(app, user, invoice.id));
        expect(lines[0]).toMatchObject({ description: 'Examen biologique', labelMasked: true });
        expect(lines[1]).toMatchObject({ description: 'Consultation', labelMasked: true });
        expect(lines[2]).toMatchObject({ description: 'Paracétamol 500 mg', labelMasked: false });
      }
    });

    it('montre le libellé réel à un rôle clinique (consultations:consultation:read) mais jamais sur le reçu', async () => {
      const invoice = await sensitiveInvoice();

      const lines = linesOf(await getInvoice(app, clinical, invoice.id));
      const receipt = await http(app).get(`${BILLING}/invoices/${invoice.id}/receipt`).set(bearer(clinical)).expect(200);

      expect(lines[0]).toMatchObject({ description: 'Dépistage VIH', labelMasked: false, isSensitive: true });
      expect(linesOf(receipt.body.data.invoice)[0]).toMatchObject({ description: 'Examen biologique', labelMasked: true });
      expect(JSON.stringify(receipt.body.data)).not.toContain('VIH');
    });

    it('masque aussi la réponse de création et d’émission pour la réceptionniste', async () => {
      const draft = await draftInvoice(app, receptionist, tenant, patientId, catalog, [{ priceListItemId: sensitiveItemId }]);

      expect(linesOf(draft)[0]).toMatchObject({ description: 'Examen biologique', labelMasked: true });
    });

    it('expose isSensitive et printLabel sur la grille et accepte leur mise à jour', async () => {
      const manager = accountant;
      const created = await http(app)
        .post(`${BILLING}/price-lists/${catalog.priceListId}/items`)
        .set(bearer(manager))
        .send({ code: `SENS-${randomBytes(2).toString('hex')}`, label: 'Test grossesse', category: 'examen', unitPrice: '1000', isSensitive: true, printLabel: 'Examen' })
        .expect(201);

      expect(created.body.data).toMatchObject({ isSensitive: true, printLabel: 'Examen' });
      const patched = await http(app).patch(`${BILLING}/price-list-items/${created.body.data.id}`).set(bearer(manager)).send({ isSensitive: false, printLabel: null }).expect(200);
      expect(patched.body.data).toMatchObject({ isSensitive: false, printLabel: null });
    });
  });

  describe('R3 : identité patient et périmètre en lecture', () => {
    it('masque l’identité sans patients:patient:read', async () => {
      const reader = await createUserWithPermissions(app, tenant, ['billing:invoice:read']);
      const invoice = await issuedInvoice(app, receptionist, tenant, patientId, catalog);

      const view = await getInvoice(app, reader, invoice.id);

      expect(view['patient']).toEqual({ id: patientId, ipp: expect.any(String), fullName: null, identityMasked: true });
    });

    it('montre l’identité avec patients:patient:read', async () => {
      const invoice = await issuedInvoice(app, receptionist, tenant, patientId, catalog);

      const view = await getInvoice(app, cashier, invoice.id);

      expect(view['patient']).toMatchObject({ id: patientId, identityMasked: false, fullName: expect.stringContaining('Patient') });
    });

    it('applique le périmètre patient en lecture de facture et de reçu (404 hors périmètre)', async () => {
      const siteB = await createSite(app, tenant, `S${randomBytes(2).toString('hex')}`);
      const outsidePatient = await createPatientRow(app, tenant, { primarySiteId: siteB });
      const invoice = await issuedInvoice(app, receptionist, tenant, outsidePatient, catalog);
      const scoped = await createUserWithPermissions(app, tenant, ['billing:invoice:read', 'billing:invoice:print', 'patients:patient:read'], {
        scopeType: 'site',
        scopeId: tenant.mainSiteId,
      });
      const insider = await createUserWithRole(app, tenant, 'cashier');

      await http(app).get(`${BILLING}/invoices/${invoice.id}`).set(bearer(scoped)).expect(404);
      await http(app).get(`${BILLING}/invoices/${invoice.id}/receipt`).set(bearer(scoped)).expect(404);
      await http(app).get(`${BILLING}/invoices/${invoice.id}`).set(bearer(insider)).expect(200);
    });
  });

  describe('R5 : reçu', () => {
    it('refuse le reçu d’un brouillon (409 invoice_not_issued)', async () => {
      const draft = await draftInvoice(app, receptionist, tenant, patientId, catalog);

      const res = await http(app).get(`${BILLING}/invoices/${draft.id}/receipt`).set(bearer(receptionist)).expect(409);

      expect(res.body.code).toBe('invoice_not_issued');
    });

    it('marque voided: true pour une facture annulée et false pour une facture émise', async () => {
      const issued = await issuedInvoice(app, receptionist, tenant, patientId, catalog);
      const toVoid = await issuedInvoice(app, receptionist, tenant, patientId, catalog);
      await http(app).post(`${BILLING}/invoices/${toVoid.id}/void`).set(bearer(accountant)).send({ reasonCode: 'duplicate' }).expect(200);

      const ok = await http(app).get(`${BILLING}/invoices/${issued.id}/receipt`).set(bearer(receptionist)).expect(200);
      const voided = await http(app).get(`${BILLING}/invoices/${toVoid.id}/receipt`).set(bearer(receptionist)).expect(200);

      expect(ok.body.data.voided).toBe(false);
      expect(voided.body.data.voided).toBe(true);
    });
  });

  describe('R6 : annulation avec motif codé', () => {
    it('exige un reasonCode connu', async () => {
      const invoice = await issuedInvoice(app, receptionist, tenant, patientId, catalog);

      await http(app).post(`${BILLING}/invoices/${invoice.id}/void`).set(bearer(accountant)).send({ reason: "texte libre" }).expect(422);
      await http(app).post(`${BILLING}/invoices/${invoice.id}/void`).set(bearer(accountant)).send({ reasonCode: 'autre' }).expect(422);
    });

    it('conserve le commentaire sur la facture mais place seul le code dans l’audit', async () => {
      const invoice = await issuedInvoice(app, receptionist, tenant, patientId, catalog);

      const res = await http(app)
        .post(`${BILLING}/invoices/${invoice.id}/void`)
        .set(bearer(accountant))
        .send({ reasonCode: 'wrong_patient', comment: 'Patient atteint de tuberculose, erreur de dossier' })
        .expect(200);
      const [entry] = await auditActions(app, tenant, 'invoice.voided', invoice.id);

      expect(res.body.data).toMatchObject({ status: 'void', voidReasonCode: 'wrong_patient', voidReason: 'Patient atteint de tuberculose, erreur de dossier' });
      expect(entry?.changes).toMatchObject({ reasonCode: 'wrong_patient' });
      expect(JSON.stringify(entry?.changes)).not.toContain('tuberculose');
    });
  });

  describe('R7 : devises sans subdivision', () => {
    it('refuse un prix de grille à décimales en XOF (422 amount_scale)', async () => {
      const res = await http(app)
        .post(`${BILLING}/price-lists/${catalog.priceListId}/items`)
        .set(bearer(accountant))
        .send({ code: `DEC-${randomBytes(2).toString('hex')}`, label: 'Prix décimal', category: 'acte', unitPrice: '1500.50' })
        .expect(422);

      expect(res.body.code).toBe('amount_scale');
    });

    it('refuse une ligne libre à décimales et arrondit le total de ligne à l’unité (moitié vers le haut)', async () => {
      const decimal = await createInvoice(app, adminAgent, { patientId, siteId: tenant.mainSiteId, lines: [{ description: 'Acte', unitPrice: '100.50' }] }).expect(422);
      const rounded = await createInvoice(app, adminAgent, {
        patientId,
        siteId: tenant.mainSiteId,
        lines: [{ description: 'Demi-dose', unitPrice: '1001', quantity: '0.5' }],
      }).expect(201);

      expect(decimal.body.code).toBe('amount_scale');
      expect(linesOf(rounded.body.data)[0]).toMatchObject({ lineTotal: '501.00', unitPrice: '1001.00' });
      expect(rounded.body.data.total).toBe('501.00');
    });

    it('refuse un encaissement à décimales (422 amount_scale)', async () => {
      const invoice = await issuedInvoice(app, receptionist, tenant, patientId, catalog);
      const session = await openSessionOk(app, cashier, await createRegisterRow(app, tenant));

      const res = await payCash(app, cashier, invoice.id, '100.50', session.id).expect(422);

      expect(res.body.code).toBe('amount_scale');
    });
  });

  describe('R9 : encaissement « other » et site de la caisse', () => {
    it('exige une session de caisse pour un paiement « other » (422)', async () => {
      const invoice = await issuedInvoice(app, receptionist, tenant, patientId, catalog);

      await http(app).post(`${BILLING}/invoices/${invoice.id}/payments`).set(bearer(cashier)).send({ method: 'other', amount: '1000', reference: 'CHQ-1' }).expect(422);
    });

    it('refuse une caisse d’un autre site que la facture (422 cash_register_site_mismatch), en espèces comme en « other »', async () => {
      const siteB = await createSite(app, tenant, `B${randomBytes(2).toString('hex')}`);
      const session = await openSessionOk(app, cashier, await createRegisterRow(app, tenant, siteB));
      const invoice = await issuedInvoice(app, receptionist, tenant, patientId, catalog);

      const cash = await payCash(app, cashier, invoice.id, '1000.00', session.id).expect(422);
      const other = await http(app)
        .post(`${BILLING}/invoices/${invoice.id}/payments`)
        .set(bearer(cashier))
        .send({ method: 'other', amount: '1000', cashSessionId: session.id, reference: 'VIR-1' })
        .expect(422);

      expect(cash.body.code).toBe('cash_register_site_mismatch');
      expect(other.body.code).toBe('cash_register_site_mismatch');
    });

    it('accepte « other » sur la caisse du même site, rattaché à la session', async () => {
      const session = await openSessionOk(app, cashier, await createRegisterRow(app, tenant));
      const invoice = await issuedInvoice(app, receptionist, tenant, patientId, catalog);

      const res = await http(app)
        .post(`${BILLING}/invoices/${invoice.id}/payments`)
        .set(bearer(cashier))
        .send({ method: 'other', amount: '1000', cashSessionId: session.id, reference: 'CHQ-2' })
        .expect(201);

      expect(res.body.data).toMatchObject({ method: 'other', cashSessionId: session.id, status: 'succeeded' });
      expect((await getInvoice(app, cashier, invoice.id)).amountPaid).toBe('1000.00');
      void issueInvoice;
    });
  });
});
