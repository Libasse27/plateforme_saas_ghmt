import { randomBytes } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createPatientRow, createPractitionerRow } from '../appointments/appointment-fixtures';
import { createRegisterRow, openSessionOk, issuedInvoice, payCash, type Catalog } from '../billing/billing-fixtures';
import type { TenantFixture, UserFixture } from '../helpers/fixtures';

export type AppointmentStatusValue = 'requested' | 'scheduled' | 'confirmed' | 'checked_in' | 'in_progress' | 'completed' | 'cancelled' | 'no_show';

/** Rendez-vous inséré directement (le tableau de bord ne lit que des comptes). */
export async function insertAppointment(
  app: INestApplication,
  tenant: TenantFixture,
  row: { siteId: string; startsAt: Date; status: AppointmentStatusValue; patientId: string; practitionerId: string; deletedAt?: Date },
): Promise<void> {
  await app.get(TenantDb).runAs(tenant.tenantId, (tx) =>
    tx.appointment.create({
      data: {
        tenantId: tenant.tenantId,
        patientId: row.patientId,
        practitionerId: row.practitionerId,
        siteId: row.siteId,
        startsAt: row.startsAt,
        endsAt: new Date(row.startsAt.getTime() + 15 * 60_000),
        status: row.status,
        deletedAt: row.deletedAt ?? null,
      },
    }),
  );
}

export async function insertPatient(
  app: INestApplication,
  tenant: TenantFixture,
  overrides: { primarySiteId?: string; createdAt?: Date; deletedAt?: Date } = {},
): Promise<string> {
  const id = await createPatientRow(app, tenant, overrides.primarySiteId ? { primarySiteId: overrides.primarySiteId } : {});
  if (overrides.createdAt || overrides.deletedAt) {
    await app.get(TenantDb).runAs(tenant.tenantId, (tx) =>
      tx.patient.update({
        where: { tenantId_id: { tenantId: tenant.tenantId, id } },
        data: { ...(overrides.createdAt ? { createdAt: overrides.createdAt } : {}), ...(overrides.deletedAt ? { deletedAt: overrides.deletedAt } : {}) },
      }),
    );
  }
  return id;
}

export { createPractitionerRow };

/** Paiement « autre mode » encaissé à un instant précis (sans session de caisse) sur une facture existante. */
export async function insertPayment(
  app: INestApplication,
  tenant: TenantFixture,
  row: { invoiceId: string; patientId: string; method: 'mobile_money' | 'card' | 'other'; amount: string; status: 'succeeded' | 'pending' | 'failed'; paidAt: Date | null; currency?: string },
): Promise<void> {
  await app.get(TenantDb).runAs(tenant.tenantId, (tx) =>
    tx.patientPayment.create({
      data: {
        tenantId: tenant.tenantId,
        invoiceId: row.invoiceId,
        patientId: row.patientId,
        method: row.method,
        amount: row.amount,
        currency: row.currency ?? 'XOF',
        status: row.status,
        paidAt: row.paidAt,
        reference: `ref-${randomBytes(3).toString('hex')}`,
      },
    }),
  );
}

export { createRegisterRow, openSessionOk, issuedInvoice, payCash };
export type { Catalog, UserFixture };
