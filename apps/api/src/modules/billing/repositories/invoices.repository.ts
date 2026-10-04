import { Injectable } from '@nestjs/common';
import type { InvoiceStatus } from '@ghmt/shared';
import { Prisma } from '../../../generated/prisma/client';
import type { PatientInvoice, PatientPayment, PriceList, PriceListItem } from '../../../generated/prisma/client';
import { zeroMoney, type Money } from '../../../common/money/money';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import type { InvoiceDetailRow, InvoicePatientRef } from '../mappers/billing.mapper';
import type { ComputedLine } from '../domain/invoice-calculation';

export interface InvoiceListCriteria {
  readonly status?: InvoiceStatus;
  readonly patientId?: string;
  readonly siteId?: string;
  readonly siteFilter: { siteId?: { in: string[] } };
  readonly afterId?: string;
  readonly take: number;
}

export interface NewLine extends ComputedLine {
  readonly priceListItemId: string | null;
  readonly category: string;
  readonly description: string;
}

export type CatalogItem = PriceListItem & { priceList: PriceList };

@Injectable()
export class InvoicesRepository {
  /** Verrou de ligne de la facture : sérialise émission, annulation et encaissements d'une même facture. */
  async lock(tx: TenantTx, tenantId: string, id: string): Promise<PatientInvoice | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM tenant.invoices WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`;
    if (rows.length === 0) return null;
    return tx.patientInvoice.findFirst({ where: { tenantId, id } });
  }

  findDetail(tx: TenantTx, tenantId: string, id: string): Promise<InvoiceDetailRow | null> {
    return tx.patientInvoice.findFirst({ where: { tenantId, id }, include: { lines: true, payments: true } });
  }

  create(tx: TenantTx, data: Prisma.PatientInvoiceUncheckedCreateInput): Promise<PatientInvoice> {
    return tx.patientInvoice.create({ data });
  }

  update(tx: TenantTx, tenantId: string, id: string, data: Prisma.PatientInvoiceUncheckedUpdateInput): Promise<PatientInvoice> {
    return tx.patientInvoice.update({ where: { tenantId_id: { tenantId, id } }, data: { ...data, rowVersion: { increment: 1 } } });
  }

  async replaceLines(tx: TenantTx, tenantId: string, invoiceId: string, lines: readonly NewLine[]): Promise<void> {
    await tx.patientInvoiceLine.deleteMany({ where: { tenantId, invoiceId } });
    await tx.patientInvoiceLine.createMany({
      data: lines.map((line, index) => ({
        tenantId,
        invoiceId,
        lineNo: index + 1,
        priceListItemId: line.priceListItemId,
        category: line.category,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        lineTotal: line.lineTotal,
      })),
    });
  }

  list(tx: TenantTx, tenantId: string, c: InvoiceListCriteria): Promise<PatientInvoice[]> {
    return tx.patientInvoice.findMany({
      where: {
        tenantId,
        ...c.siteFilter,
        ...(c.siteId ? { AND: [{ siteId: c.siteId }] } : {}),
        ...(c.status ? { status: c.status } : {}),
        ...(c.patientId ? { patientId: c.patientId } : {}),
        ...(c.afterId ? { id: { lt: c.afterId } } : {}),
      },
      orderBy: { id: 'desc' },
      take: c.take,
    });
  }

  // ───── Références (lecture seule) ─────
  findPatient(tx: TenantTx, tenantId: string, id: string, scope: Prisma.PatientWhereInput): Promise<(InvoicePatientRef & { primarySiteId: string | null }) | null> {
    return tx.patient.findFirst({
      where: { tenantId, id, deletedAt: null, mergedIntoPatientId: null, AND: [scope] },
      select: { id: true, ipp: true, firstName: true, lastName: true, primarySiteId: true },
    });
  }

  patientRef(tx: TenantTx, tenantId: string, id: string): Promise<InvoicePatientRef | null> {
    return tx.patient.findFirst({ where: { tenantId, id }, select: { id: true, ipp: true, firstName: true, lastName: true } });
  }

  async siteExists(tx: TenantTx, tenantId: string, id: string): Promise<boolean> {
    return (await tx.site.count({ where: { tenantId, id, deletedAt: null } })) > 0;
  }

  async siteName(tx: TenantTx, tenantId: string, id: string): Promise<string | null> {
    return (await tx.site.findFirst({ where: { tenantId, id }, select: { name: true } }))?.name ?? null;
  }

  async appointmentPatient(tx: TenantTx, tenantId: string, id: string): Promise<string | null> {
    return (await tx.appointment.findFirst({ where: { tenantId, id, deletedAt: null }, select: { patientId: true } }))?.patientId ?? null;
  }

  async siteIdsOfDepartments(tx: TenantTx, tenantId: string, departmentIds: readonly string[]): Promise<string[]> {
    if (departmentIds.length === 0) return [];
    const rows = await tx.department.findMany({ where: { tenantId, id: { in: [...departmentIds] } }, select: { siteId: true } });
    return rows.map((row) => row.siteId);
  }

  findCatalogItems(tx: TenantTx, tenantId: string, ids: readonly string[]): Promise<CatalogItem[]> {
    if (ids.length === 0) return Promise.resolve([]);
    return tx.priceListItem.findMany({ where: { tenantId, id: { in: [...ids] } }, include: { priceList: true } });
  }

  // ───── Encaissements ─────
  createPayment(tx: TenantTx, data: Prisma.PatientPaymentUncheckedCreateInput): Promise<PatientPayment> {
    return tx.patientPayment.create({ data });
  }

  findPayment(tx: TenantTx, tenantId: string, id: string): Promise<PatientPayment | null> {
    return tx.patientPayment.findFirst({ where: { tenantId, id } });
  }

  findPaymentByAttempt(tx: TenantTx, tenantId: string, attemptId: string): Promise<PatientPayment | null> {
    return tx.patientPayment.findFirst({ where: { tenantId, attemptId } });
  }

  /** Paiement en ligne en attente dont la tentative n'est pas encore rattachée (confirmation arrivée avant la réponse de la passerelle). */
  findUnattachedPending(tx: TenantTx, tenantId: string, invoiceId: string): Promise<PatientPayment | null> {
    return tx.patientPayment.findFirst({
      where: { tenantId, invoiceId, status: 'pending', attemptId: null, method: { in: ['mobile_money', 'card'] } },
      orderBy: { id: 'desc' },
    });
  }

  /** Mise à jour gardée : seul un paiement encore `pending` peut changer (la base le garantit aussi). */
  async updatePendingPayment(tx: TenantTx, tenantId: string, id: string, data: Prisma.PatientPaymentUncheckedUpdateManyInput): Promise<boolean> {
    const result = await tx.patientPayment.updateMany({ where: { tenantId, id, status: 'pending' }, data });
    return result.count === 1;
  }

  async pendingOnlineTotal(tx: TenantTx, tenantId: string, invoiceId: string): Promise<{ count: number; total: Money }> {
    const aggregate = await tx.patientPayment.aggregate({
      where: { tenantId, invoiceId, status: 'pending' },
      _sum: { amount: true },
      _count: true,
    });
    return { count: aggregate._count, total: aggregate._sum.amount ?? zeroMoney() };
  }

  async hasLivePayments(tx: TenantTx, tenantId: string, invoiceId: string): Promise<boolean> {
    return (await tx.patientPayment.count({ where: { tenantId, invoiceId, status: { in: ['pending', 'succeeded'] } } })) > 0;
  }
}
