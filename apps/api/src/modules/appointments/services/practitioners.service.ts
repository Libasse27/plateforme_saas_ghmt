import { Injectable } from '@nestjs/common';
import type { CreatePractitionerInput, ListPractitionersInput, UpdatePractitionerInput } from '@ghmt/shared';
import { AuditService } from '../../../common/audit/audit.service';
import { RequestContext } from '../../../common/context/request-context';
import { DomainError, type FieldIssue } from '../../../common/errors/domain-error';
import { Page, decodeUuidCursor } from '../../../common/pagination/page';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { toPractitionerView, type PractitionerView } from '../mappers/practitioner.mapper';
import { PractitionersRepository } from '../repositories/practitioners.repository';

interface PractitionerRefs {
  readonly userId?: string;
  readonly departmentId?: string;
  readonly primarySiteId?: string;
}

@Injectable()
export class PractitionersService {
  constructor(
    private readonly db: TenantDb,
    private readonly repo: PractitionersRepository,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
  ) {}

  create(input: CreatePractitionerInput): Promise<PractitionerView> {
    const { tenantId, userId: actorId } = this.context.requirePrincipal();
    return this.db.run(async (tx) => {
      await this.assertReferences(tx, tenantId, input);
      const row = await this.repo.create(tx, { ...input, tenantId, createdBy: actorId, updatedBy: actorId });
      await this.audit.record(tx, tenantId, {
        action: 'practitioner.created',
        resourceType: 'practitioner',
        resourceId: row.id,
        changes: { fields: definedKeys(input) },
      });
      return toPractitionerView(row);
    });
  }

  list(input: ListPractitionersInput): Promise<Page<PractitionerView>> {
    const { tenantId } = this.context.requirePrincipal();
    return this.db.run(async (tx) => {
      const rows = await this.repo.list(tx, tenantId, { isBookable: input.isBookable, afterId: decodeUuidCursor(input.cursor), take: input.limit + 1 });
      return Page.fromRows(rows, input.limit, toPractitionerView, (row) => row.id);
    });
  }

  get(id: string): Promise<PractitionerView> {
    const { tenantId } = this.context.requirePrincipal();
    return this.db.run(async (tx) => {
      const row = await this.repo.findById(tx, tenantId, id);
      if (!row) throw DomainError.notFound('Praticien');
      return toPractitionerView(row);
    });
  }

  update(id: string, changes: UpdatePractitionerInput): Promise<PractitionerView> {
    const { tenantId, userId: actorId } = this.context.requirePrincipal();
    const fields = definedKeys(changes);
    if (fields.length === 0) {
      throw DomainError.validation([{ path: '', code: 'empty_update', message: 'Aucun champ à modifier.' }]);
    }
    return this.db.run(async (tx) => {
      await this.assertReferences(tx, tenantId, changes);
      const count = await this.repo.update(tx, tenantId, id, { ...changes, updatedBy: actorId });
      if (count === 0) throw DomainError.notFound('Praticien');
      await this.audit.record(tx, tenantId, { action: 'practitioner.updated', resourceType: 'practitioner', resourceId: id, changes: { fields } });
      const row = await this.repo.findById(tx, tenantId, id);
      if (!row) throw DomainError.notFound('Praticien');
      return toPractitionerView(row);
    });
  }

  /** Utilisateur, service et site doivent exister dans le tenant, sinon 422. */
  private async assertReferences(tx: TenantTx, tenantId: string, refs: PractitionerRefs): Promise<void> {
    const checks: ReadonlyArray<readonly [string, string | undefined, () => Promise<boolean>]> = [
      ['userId', refs.userId, () => this.repo.userExists(tx, tenantId, refs.userId!)],
      ['departmentId', refs.departmentId, () => this.repo.departmentExists(tx, tenantId, refs.departmentId!)],
      ['primarySiteId', refs.primarySiteId, () => this.repo.siteExists(tx, tenantId, refs.primarySiteId!)],
    ];
    const issues: FieldIssue[] = [];
    for (const [path, value, exists] of checks) {
      if (value !== undefined && !(await exists())) issues.push({ path, code: 'not_found', message: 'Référence introuvable.' });
    }
    if (issues.length > 0) throw DomainError.validation(issues);
  }
}

function definedKeys(input: object): string[] {
  return Object.entries(input)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
}
