import type { INestApplication } from '@nestjs/common';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Clock } from '../../src/common/time/clock';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createPatientRow } from '../appointments/appointment-fixtures';
import { createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { BILLING, bearer, createBillingTenant, draftInvoice, http, seedCatalog, type Catalog } from './billing-fixtures';

const numberOf = (n: number, year: number): string => `FAC-${year}-${String(n).padStart(6, '0')}`;

describe('numérotation des factures sans trou (concurrence)', () => {
  let app: INestApplication;
  let tenant: TenantFixture;
  let catalog: Catalog;
  let patientId: string;
  let user: UserFixture;

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await createBillingTenant(app, 'num');
    catalog = await seedCatalog(app, tenant);
    patientId = await createPatientRow(app, tenant);
    user = await createUserWithRole(app, tenant, 'receptionist');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await app?.close();
  });

  const fixClock = (iso: string): void => {
    vi.spyOn(app.get(Clock), 'now').mockReturnValue(new Date(iso));
  };
  const issue = (id: string) => http(app).post(`${BILLING}/invoices/${id}/issue`).set(bearer(user));
  const drafts = (count: number) => Promise.all(Array.from({ length: count }, () => draftInvoice(app, user, tenant, patientId, catalog)));

  it('attribue des numéros consécutifs, uniques et sans trou à 15 émissions simultanées', async () => {
    fixClock('2031-03-15T10:00:00Z');
    const created = await drafts(15);

    const responses = await Promise.all(created.map((invoice) => issue(invoice.id)));

    expect(responses.every((r) => r.status === 200)).toBe(true);
    const numbers = responses.map((r) => r.body.data.number as string).sort();
    expect(numbers).toEqual(Array.from({ length: 15 }, (_, i) => numberOf(i + 1, 2031)));
  });

  it('n’émet qu’une fois une même facture sollicitée en parallèle et ne saute aucun numéro', async () => {
    fixClock('2031-03-16T10:00:00Z');
    const [target, next] = await drafts(2);

    const results = await Promise.all([issue(target!.id), issue(target!.id), issue(target!.id)]);
    const followUp = await issue(next!.id).expect(200);

    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    const winner = results.find((r) => r.status === 200)!.body.data.number as string;
    expect(winner).toBe(numberOf(16, 2031));
    expect(followUp.body.data.number).toBe(numberOf(17, 2031));
  });

  it('une transaction annulée ne consomme pas de numéro (le compteur est annulé avec elle)', async () => {
    fixClock('2031-03-17T10:00:00Z');
    const [target] = await drafts(1);
    await expect(
      app.get(TenantDb).runAs(tenant.tenantId, async (tx) => {
        await tx.$queryRaw`SELECT tenant.next_sequence('invoice', '2031')`;
        throw new Error('échec simulé après attribution');
      }),
    ).rejects.toThrow('échec simulé');

    const res = await issue(target!.id).expect(200);

    expect(res.body.data.number).toBe(numberOf(18, 2031));
  });

  it('repart de 1 à chaque année civile locale de l’établissement', async () => {
    fixClock('2032-01-10T08:00:00Z');
    const [first, second] = await drafts(2);

    const one = await issue(first!.id).expect(200);
    const two = await issue(second!.id).expect(200);

    expect([one.body.data.number, two.body.data.number]).toEqual([numberOf(1, 2032), numberOf(2, 2032)]);
  });

  it('la numérotation est indépendante entre établissements', async () => {
    fixClock('2033-05-01T08:00:00Z');
    const other = await createBillingTenant(app, 'num-b');
    const otherCatalog = await seedCatalog(app, other);
    const otherUser = await createUserWithRole(app, other, 'receptionist');
    const otherPatient = await createPatientRow(app, other);
    const [mine] = await drafts(1);
    const theirs = await draftInvoice(app, otherUser, other, otherPatient, otherCatalog);

    const [a, b] = await Promise.all([issue(mine!.id), http(app).post(`${BILLING}/invoices/${theirs.id}/issue`).set(bearer(otherUser))]);

    expect(a.body.data.number).toBe(numberOf(1, 2033));
    expect(b.body.data.number).toBe(numberOf(1, 2033));
  });

  it('le numéro d’une facture annulée n’est jamais réattribué', async () => {
    fixClock('2034-02-01T08:00:00Z');
    const accountant = await createUserWithRole(app, tenant, 'accountant');
    const [first, second] = await drafts(2);
    const issued = await issue(first!.id).expect(200);
    await http(app).post(`${BILLING}/invoices/${first!.id}/void`).set(bearer(accountant)).send({ reason: 'Erreur de saisie' }).expect(200);

    const next = await issue(second!.id).expect(200);

    expect(issued.body.data.number).toBe(numberOf(1, 2034));
    expect(next.body.data.number).toBe(numberOf(2, 2034));
  });
});
