import { Injectable } from '@nestjs/common';
import type {
  CashSessionView,
  CloseCashSessionInput,
  ListCashSessionsInput,
  OpenCashSessionInput,
  PermissionKey,
  ValidateCashSessionInput,
} from '@ghmt/shared';
import { AuditService } from '../../../common/audit/audit.service';
import { RequestContext } from '../../../common/context/request-context';
import { DomainError } from '../../../common/errors/domain-error';
import { addMoney, formatMoney, parseMoney, zeroMoney } from '../../../common/money/money';
import { Page, decodeUuidCursor } from '../../../common/pagination/page';
import { Clock } from '../../../common/time/clock';
import type { CashSession } from '../../../generated/prisma/client';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { cashVariance, expectedCashTotal, mayValidateSession } from '../domain/cash-session';
import { toCashSessionView } from '../mappers/billing.mapper';
import { CashierRepository, type CashSessionRow } from '../repositories/cashier.repository';
import { isUniqueViolation } from './billing-errors';
import { SiteScopeService } from './site-scope.service';

function alreadyOpen(): DomainError {
  return DomainError.conflict('cash_session_already_open', 'Une session est déjà ouverte sur cette caisse.');
}

/** Sessions de caisse : ouverture avec fond, clôture par l'ouvreur (attendu, écart), validation par un autre utilisateur. */
@Injectable()
export class CashSessionsService {
  constructor(
    private readonly db: TenantDb,
    private readonly repo: CashierRepository,
    private readonly siteScopes: SiteScopeService,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
    private readonly clock: Clock,
  ) {}

  async open(input: OpenCashSessionInput): Promise<CashSessionView> {
    const { tenantId, userId } = this.context.requirePrincipal();
    try {
      return await this.db.run(async (tx) => {
        const scope = await this.siteScopes.resolve(tx, tenantId, 'cashier:cash_session:create');
        const register = await this.repo.findRegister(tx, tenantId, input.cashRegisterId);
        // Caisse inconnue, inactive ou hors périmètre : même réponse.
        if (!register || !register.isActive || !scope.includes(register.siteId)) throw DomainError.notFound('Caisse');
        if (await this.repo.hasOpenSession(tx, tenantId, register.id)) throw alreadyOpen();
        // La contrainte unique partielle tranche les ouvertures simultanées (23505 ⇒ 409).
        const row = await this.repo.createSession(tx, {
          tenantId,
          cashRegisterId: register.id,
          currency: register.currency,
          openedBy: userId,
          openingFloat: parseMoney(input.openingFloat),
        });
        await this.audit.record(tx, tenantId, {
          action: 'cash_session.opened',
          resourceType: 'cash_session',
          resourceId: row.id,
          changes: { cashRegisterId: register.id, openingFloat: formatMoney(row.openingFloat), currency: row.currency },
        });
        return toCashSessionView(row, formatMoney(row.openingFloat));
      });
    } catch (error: unknown) {
      if (isUniqueViolation(error)) throw alreadyOpen();
      throw error;
    }
  }

  list(input: ListCashSessionsInput): Promise<Page<CashSessionView>> {
    const { tenantId, userId } = this.context.requirePrincipal();
    const afterId = decodeUuidCursor(input.cursor);
    return this.db.run(async (tx) => {
      const scope = await this.siteScopes.resolve(tx, tenantId, 'cashier:cash_session:read');
      const rows = await this.repo.listSessions(tx, tenantId, {
        status: input.status,
        openedBy: input.mine ? userId : undefined,
        siteFilter: scope.filter,
        afterId,
        take: input.limit + 1,
      });
      const page = rows.slice(0, input.limit);
      const collected = await this.repo.cashCollected(tx, tenantId, page.map((row) => row.id));
      return Page.fromRows(rows, input.limit, (row) => this.view(row, collected.get(row.id)), (row) => row.id);
    });
  }

  get(id: string): Promise<CashSessionView> {
    const { tenantId } = this.context.requirePrincipal();
    return this.db.run(async (tx) => {
      const row = await this.requireInScope(tx, tenantId, id, 'cashier:cash_session:read', await this.repo.findSession(tx, tenantId, id));
      return this.viewWithLiveTotal(tx, tenantId, row);
    });
  }

  close(id: string, input: CloseCashSessionInput): Promise<CashSessionView> {
    const { tenantId, userId } = this.context.requirePrincipal();
    return this.db.run(async (tx) => {
      // Verrou exclusif : les encaissements en espèces en cours se terminent avant le calcul de l'attendu.
      const row = await this.requireInScope(tx, tenantId, id, 'cashier:cash_session:create', await this.repo.lockSession(tx, tenantId, id, 'update'));
      if (row.openedBy !== userId) {
        throw DomainError.forbidden('cash_session_not_owner', 'Seul l’ouvreur de la session peut la clôturer.', 'cashier:cash_session:create');
      }
      if (row.status !== 'open') throw DomainError.conflict('cash_session_not_open', 'Cette session de caisse n’est pas ouverte.');
      const collected = (await this.repo.cashCollected(tx, tenantId, [id])).get(id) ?? zeroMoney();
      const expected = expectedCashTotal(row.openingFloat, collected);
      const counted = parseMoney(input.countedAmount);
      const variance = cashVariance(counted, expected);
      const closed = await this.repo.updateSession(tx, tenantId, id, {
        status: 'closed',
        closedBy: userId,
        closedAt: this.clock.now(),
        expectedTotal: expected,
        closingCounted: counted,
        variance,
        closingNote: input.note ?? null,
      });
      await this.audit.record(tx, tenantId, {
        action: 'cash_session.closed',
        resourceType: 'cash_session',
        resourceId: id,
        changes: { expectedTotal: formatMoney(expected), countedAmount: formatMoney(counted), variance: formatMoney(variance) },
      });
      return toCashSessionView(closed, formatMoney(expected));
    });
  }

  validate(id: string, input: ValidateCashSessionInput): Promise<CashSessionView> {
    const { tenantId, userId } = this.context.requirePrincipal();
    return this.db.run(async (tx) => {
      const row = await this.requireInScope(tx, tenantId, id, 'cashier:cash_session:validate', await this.repo.lockSession(tx, tenantId, id, 'update'));
      if (row.status !== 'closed') throw DomainError.conflict('cash_session_not_closed', 'Seule une session clôturée peut être validée.');
      if (!mayValidateSession(row, userId)) {
        throw DomainError.forbidden('separation_of_duties', 'La validation doit être faite par un autre utilisateur que l’ouvreur ou celui qui a clôturé.', 'cashier:cash_session:validate');
      }
      const validated = await this.repo.updateSession(tx, tenantId, id, {
        status: 'validated',
        validatedBy: userId,
        validatedAt: this.clock.now(),
        validationNote: input.note ?? null,
      });
      await this.audit.record(tx, tenantId, {
        action: 'cash_session.validated',
        resourceType: 'cash_session',
        resourceId: id,
        changes: { variance: row.variance ? formatMoney(row.variance) : null },
      });
      return this.view(validated);
    });
  }

  /** Session inconnue ou hors du périmètre de la permission ⇒ 404. */
  private async requireInScope(tx: TenantTx, tenantId: string, id: string, permission: PermissionKey, row: CashSessionRow | null): Promise<CashSessionRow> {
    const scope = await this.siteScopes.resolve(tx, tenantId, permission);
    if (!row || !scope.includes(row.register.siteId)) throw DomainError.notFound('Session de caisse');
    return row;
  }

  private async viewWithLiveTotal(tx: TenantTx, tenantId: string, row: CashSessionRow): Promise<CashSessionView> {
    const collected = (await this.repo.cashCollected(tx, tenantId, [row.id])).get(row.id);
    return this.view(row, collected);
  }

  private view(row: CashSession, collected = zeroMoney()): CashSessionView {
    return toCashSessionView(row, formatMoney(addMoney(row.openingFloat, collected)));
  }
}
