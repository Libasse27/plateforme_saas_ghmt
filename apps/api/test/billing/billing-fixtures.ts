import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createTenantFixture, type TenantFixture, type UserFixture } from '../helpers/fixtures';

export const BILLING = '/api/v1/billing';
export const CASHIER = '/api/v1/cashier';
export const WEBHOOKS = '/api/v1/webhooks/payments';
export const UNKNOWN_ID = '018f0000-0000-7000-8000-000000000000';

/** Active explicitement les modules `billing` et `cashier` (en plus des rendez-vous). */
export function createBillingTenant(app: INestApplication, prefix = 'fac'): Promise<TenantFixture> {
  return createTenantFixture(app, { optionalModules: ['appointments', 'billing', 'cashier'], prefix });
}

export const http = (app: INestApplication): ReturnType<typeof request> => request(app.getHttpServer());
export const bearer = (user: Pick<UserFixture, 'token'>): { Authorization: string } => ({ Authorization: `Bearer ${user.token}` });

export interface Catalog {
  readonly priceListId: string;
  readonly consultation: { id: string; price: string };
  readonly exam: { id: string; price: string };
  readonly drug: { id: string; price: string };
}

/** Grille tarifaire insérée directement en base (les tests de la grille passent, eux, par l'API). */
export async function seedCatalog(app: INestApplication, tenant: TenantFixture): Promise<Catalog> {
  const suffix = randomBytes(3).toString('hex');
  return app.get(TenantDb).runAs(tenant.tenantId, async (tx) => {
    const list = await tx.priceList.create({
      data: { tenantId: tenant.tenantId, code: `STD-${suffix}`, name: 'Tarifs standard', currency: 'XOF' },
      select: { id: true },
    });
    const item = (code: string, label: string, category: string, unitPrice: string) =>
      tx.priceListItem.create({
        data: { tenantId: tenant.tenantId, priceListId: list.id, code, label, category, unitPrice },
        select: { id: true },
      });
    const [consultation, exam, drug] = await Promise.all([
      item('CONS', 'Consultation générale', 'consultation', '5000.00'),
      item('NFS', 'Numération formule sanguine', 'examen', '3500.00'),
      item('PARA', 'Paracétamol 500 mg', 'medicament', '150.00'),
    ]);
    return {
      priceListId: list.id,
      consultation: { id: consultation.id, price: '5000.00' },
      exam: { id: exam.id, price: '3500.00' },
      drug: { id: drug.id, price: '150.00' },
    };
  });
}

export function createInvoice(app: INestApplication, user: UserFixture, body: Record<string, unknown>) {
  return http(app).post(`${BILLING}/invoices`).set(bearer(user)).send(body);
}

export interface InvoiceBody {
  readonly id: string;
  readonly number: string | null;
  readonly status: string;
  readonly total: string;
  readonly amountPaid: string;
  readonly balance: string;
  readonly lines: { id: string; description: string; lineTotal: string }[];
  readonly payments: { id: string; method: string; amount: string; status: string; cashSessionId: string | null }[];
  readonly [key: string]: unknown;
}

/** Brouillon de facture (consultation + examen = 8500.00). */
export async function draftInvoice(
  app: INestApplication,
  user: UserFixture,
  tenant: TenantFixture,
  patientId: string,
  catalog: Catalog,
  lines: Record<string, unknown>[] = [{ priceListItemId: catalog.consultation.id }, { priceListItemId: catalog.exam.id }],
): Promise<InvoiceBody> {
  const res = await createInvoice(app, user, { patientId, siteId: tenant.mainSiteId, lines }).expect(201);
  return res.body.data as InvoiceBody;
}

export async function issueInvoice(app: INestApplication, user: UserFixture, id: string): Promise<InvoiceBody> {
  const res = await http(app).post(`${BILLING}/invoices/${id}/issue`).set(bearer(user)).expect(200);
  return res.body.data as InvoiceBody;
}

export async function issuedInvoice(
  app: INestApplication,
  user: UserFixture,
  tenant: TenantFixture,
  patientId: string,
  catalog: Catalog,
  lines?: Record<string, unknown>[],
): Promise<InvoiceBody> {
  const draft = await draftInvoice(app, user, tenant, patientId, catalog, lines);
  return issueInvoice(app, user, draft.id);
}

export async function getInvoice(app: INestApplication, user: UserFixture, id: string): Promise<InvoiceBody> {
  const res = await http(app).get(`${BILLING}/invoices/${id}`).set(bearer(user)).expect(200);
  return res.body.data as InvoiceBody;
}

export function createRegisterRow(app: INestApplication, tenant: TenantFixture, siteId: string = tenant.mainSiteId): Promise<string> {
  const code = `C-${randomBytes(3).toString('hex')}`;
  return app
    .get(TenantDb)
    .runAs(tenant.tenantId, (tx) =>
      tx.cashRegister.create({ data: { tenantId: tenant.tenantId, siteId, code, name: `Caisse ${code}`, currency: 'XOF' }, select: { id: true } }),
    )
    .then((register) => register.id);
}

export function openSession(app: INestApplication, user: UserFixture, cashRegisterId: string, openingFloat = '10000.00') {
  return http(app).post(`${CASHIER}/sessions`).set(bearer(user)).send({ cashRegisterId, openingFloat });
}

export async function openSessionOk(app: INestApplication, user: UserFixture, cashRegisterId: string, openingFloat = '10000.00') {
  const res = await openSession(app, user, cashRegisterId, openingFloat).expect(201);
  return res.body.data as { id: string; status: string; expectedTotal: string; [key: string]: unknown };
}

export function payCash(app: INestApplication, user: UserFixture, invoiceId: string, amount: string, cashSessionId: string) {
  return http(app).post(`${BILLING}/invoices/${invoiceId}/payments`).set(bearer(user)).send({ method: 'cash', amount, cashSessionId });
}

export function payMobile(app: INestApplication, user: UserFixture, invoiceId: string, amount: string, payerPhone = '+221771234567') {
  return http(app).post(`${BILLING}/invoices/${invoiceId}/payments`).set(bearer(user)).send({ method: 'mobile_money', amount, payerPhone });
}

export function auditActions(app: INestApplication, tenant: TenantFixture, action: string, resourceId?: string) {
  return app
    .get(TenantDb)
    .runAs(tenant.tenantId, (tx) => tx.auditLog.findMany({ where: { action, ...(resourceId ? { resourceId } : {}) }, orderBy: { chainSeq: 'asc' } }));
}
