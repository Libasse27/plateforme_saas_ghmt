import { Injectable } from '@nestjs/common';
import type { CashSessionStatus } from '@ghmt/shared';
import type { CashRegister, CashSession, Prisma } from '../../../generated/prisma/client';
import { zeroMoney, type Money } from '../../../common/money/money';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';

export type CashSessionRow = CashSession & { register: CashRegister };

export interface SessionListCriteria {
  readonly status?: CashSessionStatus;
  readonly openedBy?: string;
  readonly siteFilter: { siteId?: { in: string[] } };
  readonly afterId?: string;
  readonly take: number;
}

@Injectable()
export class CashierRepository {
  listRegisters(tx: TenantTx, tenantId: string, siteFilter: { siteId?: { in: string[] } }): Promise<CashRegister[]> {
    return tx.cashRegister.findMany({ where: { tenantId, ...siteFilter }, orderBy: [{ siteId: 'asc' }, { code: 'asc' }] });
  }

  findRegister(tx: TenantTx, tenantId: string, id: string): Promise<CashRegister | null> {
    return tx.cashRegister.findFirst({ where: { tenantId, id } });
  }

  registerCodeExists(tx: TenantTx, tenantId: string, siteId: string, code: string): Promise<boolean> {
    return tx.cashRegister.count({ where: { tenantId, siteId, code } }).then((count) => count > 0);
  }

  createRegister(tx: TenantTx, data: Prisma.CashRegisterUncheckedCreateInput): Promise<CashRegister> {
    return tx.cashRegister.create({ data });
  }

  async siteExists(tx: TenantTx, tenantId: string, id: string): Promise<boolean> {
    return (await tx.site.count({ where: { tenantId, id, deletedAt: null } })) > 0;
  }

  async siteIdsOfDepartments(tx: TenantTx, tenantId: string, departmentIds: readonly string[]): Promise<string[]> {
    if (departmentIds.length === 0) return [];
    const rows = await tx.department.findMany({ where: { tenantId, id: { in: [...departmentIds] } }, select: { siteId: true } });
    return rows.map((row) => row.siteId);
  }

  async hasOpenSession(tx: TenantTx, tenantId: string, cashRegisterId: string): Promise<boolean> {
    return (await tx.cashSession.count({ where: { tenantId, cashRegisterId, closedAt: null } })) > 0;
  }

  createSession(tx: TenantTx, data: Prisma.CashSessionUncheckedCreateInput): Promise<CashSession> {
    return tx.cashSession.create({ data });
  }

  findSession(tx: TenantTx, tenantId: string, id: string): Promise<CashSessionRow | null> {
    return tx.cashSession.findFirst({ where: { tenantId, id }, include: { register: true } });
  }

  /** Verrou de la session : la clôture et les encaissements en espèces se sérialisent sur cette ligne. */
  async lockSession(tx: TenantTx, tenantId: string, id: string, mode: 'update' | 'share'): Promise<CashSessionRow | null> {
    const rows =
      mode === 'update'
        ? await tx.$queryRaw<{ id: string }[]>`SELECT id FROM tenant.cash_sessions WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR UPDATE`
        : await tx.$queryRaw<{ id: string }[]>`SELECT id FROM tenant.cash_sessions WHERE tenant_id = ${tenantId}::uuid AND id = ${id}::uuid FOR SHARE`;
    if (rows.length === 0) return null;
    return this.findSession(tx, tenantId, id);
  }

  updateSession(tx: TenantTx, tenantId: string, id: string, data: Prisma.CashSessionUncheckedUpdateInput): Promise<CashSession> {
    return tx.cashSession.update({ where: { tenantId_id: { tenantId, id } }, data });
  }

  listSessions(tx: TenantTx, tenantId: string, c: SessionListCriteria): Promise<CashSessionRow[]> {
    return tx.cashSession.findMany({
      where: {
        tenantId,
        ...(c.status ? { status: c.status } : {}),
        ...(c.openedBy ? { openedBy: c.openedBy } : {}),
        ...(c.siteFilter.siteId ? { register: { siteId: c.siteFilter.siteId } } : {}),
        ...(c.afterId ? { id: { lt: c.afterId } } : {}),
      },
      include: { register: true },
      orderBy: { id: 'desc' },
      take: c.take,
    });
  }

  /** Espèces encaissées (paiements réussis) par session ; les autres modes ne passent pas par le tiroir-caisse. */
  async cashCollected(tx: TenantTx, tenantId: string, sessionIds: readonly string[]): Promise<Map<string, Money>> {
    if (sessionIds.length === 0) return new Map();
    const groups = await tx.patientPayment.groupBy({
      by: ['cashSessionId'],
      where: { tenantId, cashSessionId: { in: [...sessionIds] }, method: 'cash', status: 'succeeded' },
      _sum: { amount: true },
    });
    return new Map(groups.map((group) => [group.cashSessionId as string, group._sum.amount ?? zeroMoney()]));
  }
}
