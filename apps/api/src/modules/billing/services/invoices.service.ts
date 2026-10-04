import { Injectable } from '@nestjs/common';
import type {
  CreateInvoiceInput,
  InvoiceDetailView,
  InvoiceSummaryView,
  ListInvoicesInput,
  PermissionKey,
  ReceiptView,
  ReplaceInvoiceLinesInput,
  VoidInvoiceInput,
} from '@ghmt/shared';
import { AuditService } from '../../../common/audit/audit.service';
import { scopesFor } from '../../../common/authz/authorization.service';
import { RequestContext } from '../../../common/context/request-context';
import { DomainError } from '../../../common/errors/domain-error';
import { formatMoney, zeroMoney } from '../../../common/money/money';
import { Page, decodeUuidCursor } from '../../../common/pagination/page';
import { Clock } from '../../../common/time/clock';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { loadTenantProfile } from '../../../infrastructure/tenancy/tenant-profile';
import { buildPatientScopeFilter } from '../../patients/domain/patient-scope';
import { totalOfLines } from '../domain/invoice-calculation';
import { INVOICE_SEQUENCE_SCOPE, formatInvoiceNumber, invoiceYearOf } from '../domain/invoice-number';
import { statusAfterPayments } from '../domain/invoice-status';
import { toInvoiceDetail, toInvoiceSummary } from '../mappers/billing.mapper';
import { InvoicesRepository } from '../repositories/invoices.repository';
import { refIssue } from './billing-errors';
import { InvoiceLinesResolver } from './invoice-lines.resolver';
import { SiteScopeService } from './site-scope.service';

@Injectable()
export class InvoicesService {
  constructor(
    private readonly db: TenantDb,
    private readonly repo: InvoicesRepository,
    private readonly resolver: InvoiceLinesResolver,
    private readonly siteScopes: SiteScopeService,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
    private readonly clock: Clock,
  ) {}

  create(input: CreateInvoiceInput): Promise<InvoiceDetailView> {
    const { tenantId, userId } = this.context.requirePrincipal();
    return this.db.run(async (tx) => {
      const siteScope = await this.siteScopes.resolve(tx, tenantId, 'billing:invoice:create');
      if (!siteScope.includes(input.siteId)) {
        throw DomainError.forbidden('site_out_of_scope', 'Ce site est hors de votre périmètre.', 'billing:invoice:create');
      }
      if (!(await this.repo.siteExists(tx, tenantId, input.siteId))) throw refIssue('siteId', 'Site introuvable.');
      // Patient hors périmètre = patient inexistant (même réponse : on ne révèle pas son existence).
      const patient = await this.repo.findPatient(tx, tenantId, input.patientId, await this.patientScopeFilter(tx, tenantId));
      if (!patient) throw DomainError.notFound('Patient');
      if (input.appointmentId) {
        const appointmentPatient = await this.repo.appointmentPatient(tx, tenantId, input.appointmentId);
        if (appointmentPatient !== input.patientId) throw refIssue('appointmentId', 'Rendez-vous introuvable pour ce patient.');
      }
      const profile = await loadTenantProfile(tx);
      const lines = await this.resolver.resolve(tx, tenantId, profile.baseCurrency, input.lines);
      const total = totalOfLines(lines);
      const invoice = await this.repo.create(tx, {
        tenantId,
        patientId: input.patientId,
        siteId: input.siteId,
        appointmentId: input.appointmentId ?? null,
        currency: profile.baseCurrency,
        subtotal: total,
        total,
        notes: input.notes ?? null,
        createdBy: userId,
        updatedBy: userId,
      });
      await this.repo.replaceLines(tx, tenantId, invoice.id, lines);
      await this.audit.record(tx, tenantId, {
        action: 'invoice.created',
        resourceType: 'invoice',
        resourceId: invoice.id,
        patientId: invoice.patientId,
        changes: { siteId: invoice.siteId, total: formatMoney(total), lineCount: lines.length, currency: invoice.currency },
      });
      return this.detail(tx, tenantId, invoice.id);
    });
  }

  list(input: ListInvoicesInput): Promise<Page<InvoiceSummaryView>> {
    const { tenantId } = this.context.requirePrincipal();
    const afterId = decodeUuidCursor(input.cursor);
    return this.db.run(async (tx) => {
      const siteScope = await this.siteScopes.resolve(tx, tenantId, 'billing:invoice:read');
      const rows = await this.repo.list(tx, tenantId, {
        status: input.status,
        patientId: input.patientId,
        siteId: input.siteId,
        siteFilter: siteScope.filter,
        afterId,
        take: input.limit + 1,
      });
      const page = Page.fromRows(rows, input.limit, toInvoiceSummary, (row) => row.id);
      await this.audit.record(tx, tenantId, {
        action: 'invoice.listed',
        resourceType: 'invoice',
        patientIds: [...new Set(page.items.map((item) => item.patientId))],
        changes: { resultCount: page.items.length },
      });
      return page;
    });
  }

  get(id: string): Promise<InvoiceDetailView> {
    const { tenantId } = this.context.requirePrincipal();
    return this.db.run(async (tx) => {
      const view = await this.readInScope(tx, tenantId, id, 'billing:invoice:read');
      await this.audit.record(tx, tenantId, { action: 'invoice.read', resourceType: 'invoice', resourceId: id, patientId: view.patientId });
      return view;
    });
  }

  receipt(id: string): Promise<ReceiptView> {
    const { tenantId } = this.context.requirePrincipal();
    return this.db.run(async (tx) => {
      const invoice = await this.readInScope(tx, tenantId, id, 'billing:invoice:print');
      const profile = await loadTenantProfile(tx);
      const site = await this.repo.siteName(tx, tenantId, invoice.siteId);
      await this.audit.record(tx, tenantId, {
        action: 'invoice.printed',
        resourceType: 'invoice',
        resourceId: id,
        patientId: invoice.patientId,
        changes: { number: invoice.number },
      });
      return { establishment: profile.name, site: site ?? '', invoice, printedAt: this.clock.now().toISOString() };
    });
  }

  replaceLines(id: string, input: ReplaceInvoiceLinesInput): Promise<InvoiceDetailView> {
    const { tenantId, userId } = this.context.requirePrincipal();
    return this.db.run(async (tx) => {
      const siteScope = await this.siteScopes.resolve(tx, tenantId, 'billing:invoice:create');
      const invoice = await this.repo.lock(tx, tenantId, id);
      if (!invoice || !siteScope.includes(invoice.siteId)) throw DomainError.notFound('Facture');
      this.assertDraft(invoice.status);
      const lines = await this.resolver.resolve(tx, tenantId, invoice.currency, input.lines);
      const total = totalOfLines(lines);
      await this.repo.replaceLines(tx, tenantId, id, lines);
      await this.repo.update(tx, tenantId, id, { subtotal: total, total, updatedBy: userId });
      await this.audit.record(tx, tenantId, {
        action: 'invoice.lines_replaced',
        resourceType: 'invoice',
        resourceId: id,
        patientId: invoice.patientId,
        changes: { total: formatMoney(total), lineCount: lines.length },
      });
      return this.detail(tx, tenantId, id);
    });
  }

  issue(id: string): Promise<InvoiceDetailView> {
    const { tenantId, userId } = this.context.requirePrincipal();
    return this.db.run(async (tx) => {
      const siteScope = await this.siteScopes.resolve(tx, tenantId, 'billing:invoice:create');
      // Le verrou de ligne précède l'attribution du numéro : une émission perdante ne consomme aucun numéro.
      const invoice = await this.repo.lock(tx, tenantId, id);
      if (!invoice || !siteScope.includes(invoice.siteId)) throw DomainError.notFound('Facture');
      this.assertDraft(invoice.status);
      const now = this.clock.now();
      const profile = await loadTenantProfile(tx);
      const year = invoiceYearOf(now, profile.timezone);
      const [{ seq }] = await tx.$queryRaw<{ seq: bigint }[]>`SELECT tenant.next_sequence(${INVOICE_SEQUENCE_SCOPE}, ${String(year)}) AS seq`;
      const number = formatInvoiceNumber(year, seq);
      const status = invoice.total.isZero() ? statusAfterPayments(invoice.total, zeroMoney()) : 'issued';
      await this.repo.update(tx, tenantId, id, { number, status, issuedAt: now, issuedBy: userId, updatedBy: userId });
      await this.audit.record(tx, tenantId, {
        action: 'invoice.issued',
        resourceType: 'invoice',
        resourceId: id,
        patientId: invoice.patientId,
        changes: { number, total: formatMoney(invoice.total), currency: invoice.currency },
      });
      return this.detail(tx, tenantId, id);
    });
  }

  voidInvoice(id: string, input: VoidInvoiceInput): Promise<InvoiceDetailView> {
    const { tenantId, userId } = this.context.requirePrincipal();
    return this.db.run(async (tx) => {
      const siteScope = await this.siteScopes.resolve(tx, tenantId, 'billing:invoice:validate');
      const invoice = await this.repo.lock(tx, tenantId, id);
      if (!invoice || !siteScope.includes(invoice.siteId)) throw DomainError.notFound('Facture');
      if (invoice.status === 'void') throw DomainError.conflict('invoice_already_void', 'Cette facture est déjà annulée.');
      if (!invoice.amountPaid.isZero() || (await this.repo.hasLivePayments(tx, tenantId, id))) {
        throw DomainError.conflict('invoice_has_payments', 'Une facture encaissée ou avec un paiement en attente ne peut pas être annulée.');
      }
      await this.repo.update(tx, tenantId, id, { status: 'void', voidedAt: this.clock.now(), voidedBy: userId, voidReason: input.reason, updatedBy: userId });
      await this.audit.record(tx, tenantId, {
        action: 'invoice.voided',
        resourceType: 'invoice',
        resourceId: id,
        patientId: invoice.patientId,
        changes: { number: invoice.number, reason: input.reason },
      });
      return this.detail(tx, tenantId, id);
    });
  }

  /** Facture lisible dans la portée de la permission, sinon 404 (on ne révèle pas l'existence d'une facture d'un autre site). */
  private async readInScope(tx: TenantTx, tenantId: string, id: string, permission: PermissionKey): Promise<InvoiceDetailView> {
    const siteScope = await this.siteScopes.resolve(tx, tenantId, permission);
    const row = await this.repo.findDetail(tx, tenantId, id);
    if (!row || !siteScope.includes(row.siteId)) throw DomainError.notFound('Facture');
    return this.view(tx, tenantId, row);
  }

  private async detail(tx: TenantTx, tenantId: string, id: string): Promise<InvoiceDetailView> {
    const row = await this.repo.findDetail(tx, tenantId, id);
    if (!row) throw DomainError.notFound('Facture');
    return this.view(tx, tenantId, row);
  }

  private async view(tx: TenantTx, tenantId: string, row: NonNullable<Awaited<ReturnType<InvoicesRepository['findDetail']>>>): Promise<InvoiceDetailView> {
    const patient = await this.repo.patientRef(tx, tenantId, row.patientId);
    if (!patient) throw DomainError.notFound('Patient');
    return toInvoiceDetail(row, patient);
  }

  private assertDraft(status: string): void {
    if (status !== 'draft') throw DomainError.conflict('invoice_not_draft', 'Seul un brouillon peut être modifié ou émis.');
  }

  private async patientScopeFilter(tx: TenantTx, tenantId: string) {
    const scope = scopesFor('patients:patient:read', this.context.grants);
    const departmentSites = scope.allTenant ? [] : await this.repo.siteIdsOfDepartments(tx, tenantId, scope.departmentIds);
    return buildPatientScopeFilter(scope, departmentSites);
  }
}
