import { Injectable } from '@nestjs/common';
import type {
  AppointmentStatus,
  ChangeAppointmentStatusInput,
  CreateAppointmentInput,
  ListAppointmentsInput,
  PermissionKey,
  RescheduleAppointmentInput,
} from '@ghmt/shared';
import { AuditService } from '../../../common/audit/audit.service';
import { scopesFor } from '../../../common/authz/authorization.service';
import { EntitlementService } from '../../../common/authz/entitlement.service';
import { RequestContext } from '../../../common/context/request-context';
import { DomainError } from '../../../common/errors/domain-error';
import { Page, decodeDateIdCursor } from '../../../common/pagination/page';
import { Clock } from '../../../common/time/clock';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { loadTenantProfile } from '../../../infrastructure/tenancy/tenant-profile';
import { buildPatientScopeFilter, isPatientWithinScope } from '../../patients/domain/patient-scope';
import { isWithinScope, type PermissionScope } from '../domain/appointment-scope';
import {
  assertDeletable,
  assertPatientAlive,
  assertSlotNotInPast,
  assertTransitionTiming,
  requiresLivingPatient,
} from '../domain/appointment-rules';
import { assertTransition } from '../domain/appointment-state-machine';
import { toAppointmentView, type AppointmentRow, type AppointmentView, type ViewOptions } from '../mappers/appointment.mapper';
import { AppointmentsRepository } from '../repositories/appointments.repository';

const MAX_RANGE_DAYS = 31;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const RESCHEDULABLE: readonly AppointmentStatus[] = ['scheduled', 'confirmed'];
const CURSOR_SEPARATOR = '|';

/** Sources acceptées par le realm personnel : le guichet et le téléphone. `web` / `mobile_app` sont réservées aux futurs canaux patient. */
const PERSONNEL_SOURCES: readonly string[] = ['front_desk', 'phone'];

/** La source ne doit pas être fiée au corps : un agent ne peut pas se faire passer pour un canal en ligne. */
function assertPersonnelSource(source: string): void {
  if (PERSONNEL_SOURCES.includes(source)) return;
  throw DomainError.validation([{ path: 'source', code: 'source_not_allowed', message: 'Source non autorisée : seules « front_desk » et « phone » sont acceptées.' }]);
}

const monthKeyOf = (date: Date): string => `${date.getUTCFullYear()}-${date.getUTCMonth()}`;

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly db: TenantDb,
    private readonly repo: AppointmentsRepository,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
    private readonly clock: Clock,
    private readonly entitlements: EntitlementService,
  ) {}

  create(input: CreateAppointmentInput): Promise<AppointmentView> {
    const { tenantId, userId } = this.context.requirePrincipal();
    assertPersonnelSource(input.source);
    const scope = this.scopeOf('appointments:appointment:create');
    return this.db.run(async (tx) => {
      const practitioner = await this.repo.findPractitioner(tx, tenantId, input.practitionerId);
      if (!practitioner) throw refNotFound('practitionerId', 'Praticien introuvable.');
      if (!practitioner.isBookable) {
        throw DomainError.unprocessable('practitioner_not_bookable', 'Ce praticien n’accepte pas de rendez-vous.');
      }
      if (!isWithinScope(scope, { siteId: input.siteId, departmentId: practitioner.departmentId })) {
        throw DomainError.forbidden('site_out_of_scope', 'Ce site est hors de votre périmètre.', 'appointments:appointment:create');
      }
      if (!(await this.repo.siteExists(tx, tenantId, input.siteId))) throw refNotFound('siteId', 'Site introuvable.');
      // Patient hors périmètre = patient inexistant (même réponse : on ne révèle pas son existence).
      const patientScope = this.scopeOf('patients:patient:read');
      const departmentSites = patientScope.allTenant ? [] : await this.repo.siteIdsOfDepartments(tx, tenantId, patientScope.departmentIds);
      const patient = await this.repo.findPatient(tx, tenantId, input.patientId, buildPatientScopeFilter(patientScope, departmentSites));
      if (!patient) throw refNotFound('patientId', 'Patient introuvable.');
      assertPatientAlive(patient);
      assertSlotNotInPast(new Date(input.startsAt), this.clock.now());
      // Limite souple du plan : au-delà de 120 % du quota mensuel, les sources en ligne sont refusées (jamais le guichet).
      await this.entitlements.assertAppointmentAllowed(tx, { source: input.source, startsAt: new Date(input.startsAt) });

      // Le chevauchement est tranché par la contrainte EXCLUDE (23P01 ⇒ 409 slot_unavailable).
      const row = await this.repo.create(tx, {
        tenantId,
        patientId: input.patientId,
        practitionerId: input.practitionerId,
        siteId: input.siteId,
        startsAt: new Date(input.startsAt),
        endsAt: new Date(input.endsAt),
        status: 'scheduled',
        source: input.source,
        reason: input.reason,
        createdBy: userId,
        updatedBy: userId,
      });
      await this.audit.record(tx, tenantId, {
        action: 'appointment.created',
        resourceType: 'appointment',
        resourceId: row.id,
        patientId: row.patientId,
        changes: { practitionerId: row.practitionerId, siteId: row.siteId, source: row.source },
      });
      return this.view(await this.requireInScope(tx, tenantId, row.id, scope));
    });
  }

  list(input: ListAppointmentsInput, cursor: string | undefined): Promise<Page<AppointmentView>> {
    const { tenantId } = this.context.requirePrincipal();
    const from = new Date(input.from);
    const to = new Date(input.to);
    assertRange(from, to);
    const scope = this.scopeOf('appointments:appointment:read');
    const after = decodeDateIdCursor(cursor);
    return this.db.run(async (tx) => {
      const rows = await this.repo.list(tx, tenantId, {
        from,
        to,
        practitionerId: input.practitionerId,
        siteId: input.siteId,
        patientId: input.patientId,
        status: input.status,
        scope,
        after: after && { startsAt: after.date, id: after.id },
        take: input.limit + 1,
      });
      const optionsOf = this.viewOptions();
      const page = Page.fromRows(rows, input.limit, (row) => toAppointmentView(row, optionsOf(row)), (row) => `${row.startsAt.toISOString()}${CURSOR_SEPARATOR}${row.id}`);
      // Lecture groupée de rendez-vous nominatifs : les patients concernés sont consignés.
      await this.audit.record(tx, tenantId, {
        action: 'appointment.listed',
        resourceType: 'appointment',
        patientIds: [...new Set(page.items.map((item) => item.patientId))],
        changes: { resultCount: page.items.length },
      });
      return page;
    });
  }

  get(id: string): Promise<AppointmentView> {
    const { tenantId } = this.context.requirePrincipal();
    const scope = this.scopeOf('appointments:appointment:read');
    return this.db.run(async (tx) => {
      const row = await this.requireInScope(tx, tenantId, id, scope);
      await this.audit.record(tx, tenantId, { action: 'appointment.read', resourceType: 'appointment', resourceId: id, patientId: row.patientId });
      return this.view(row);
    });
  }

  reschedule(id: string, input: RescheduleAppointmentInput): Promise<AppointmentView> {
    const { tenantId, userId } = this.context.requirePrincipal();
    const scope = this.scopeOf('appointments:appointment:update');
    return this.db.run(async (tx) => {
      const current = await this.requireInScope(tx, tenantId, id, scope);
      if (!RESCHEDULABLE.includes(current.status)) {
        throw DomainError.conflict('invalid_transition', 'Ce rendez-vous ne peut plus être reprogrammé dans son état actuel.');
      }
      await this.requirePatientInScope(tx, tenantId, current);
      assertPatientAlive(current.patient);
      assertSlotNotInPast(new Date(input.startsAt), this.clock.now());
      // Un déplacement vers un autre mois consomme le quota de ce mois : même contrôle qu'à la création.
      if (monthKeyOf(current.startsAt) !== monthKeyOf(new Date(input.startsAt))) {
        await this.entitlements.assertAppointmentAllowed(tx, { source: current.source, startsAt: new Date(input.startsAt) });
      }
      const count = await this.repo.updateGuarded(tx, tenantId, id, current.status, {
        startsAt: new Date(input.startsAt),
        endsAt: new Date(input.endsAt),
        updatedBy: userId,
      });
      if (count === 0) throw concurrentUpdate();
      await this.audit.record(tx, tenantId, {
        action: 'appointment.rescheduled',
        resourceType: 'appointment',
        resourceId: id,
        patientId: current.patientId,
        changes: { fields: ['startsAt', 'endsAt'] },
      });
      return this.view(await this.requireInScope(tx, tenantId, id, scope));
    });
  }

  changeStatus(id: string, input: ChangeAppointmentStatusInput): Promise<AppointmentView> {
    const { tenantId, userId } = this.context.requirePrincipal();
    const scope = this.scopeOf('appointments:appointment:update');
    return this.db.run(async (tx) => {
      const current = await this.requireInScope(tx, tenantId, id, scope);
      assertTransition(current.status, input.status);
      if (requiresLivingPatient(input.status)) assertPatientAlive(current.patient);
      const timeZone = input.status === 'checked_in' ? (await loadTenantProfile(tx)).timezone : 'UTC';
      assertTransitionTiming(input.status, { now: this.clock.now(), startsAt: current.startsAt, timeZone });
      if (input.status === 'cancelled' && !input.cancelReason?.trim()) {
        throw DomainError.validation([{ path: 'cancelReason', code: 'required', message: 'Le motif d’annulation est obligatoire.' }]);
      }
      const count = await this.repo.updateGuarded(tx, tenantId, id, current.status, {
        status: input.status,
        updatedBy: userId,
        ...(input.status === 'cancelled' ? { cancelReason: input.cancelReason } : {}),
        ...(input.status === 'checked_in' ? { checkedInAt: this.clock.now() } : {}),
      });
      if (count === 0) throw concurrentUpdate();
      await this.audit.record(tx, tenantId, {
        action: 'appointment.status_changed',
        resourceType: 'appointment',
        resourceId: id,
        patientId: current.patientId,
        changes: { from: current.status, to: input.status },
      });
      return this.view(await this.requireInScope(tx, tenantId, id, scope));
    });
  }

  remove(id: string): Promise<void> {
    const { tenantId, userId } = this.context.requirePrincipal();
    const scope = this.scopeOf('appointments:appointment:delete');
    return this.db.run(async (tx) => {
      const current = await this.requireInScope(tx, tenantId, id, scope);
      assertDeletable(current.status);
      await this.repo.softDelete(tx, tenantId, id, userId);
      await this.audit.record(tx, tenantId, {
        action: 'appointment.deleted',
        resourceType: 'appointment',
        resourceId: id,
        patientId: current.patientId,
      });
    });
  }

  /**
   * Motif de consultation et d'annulation : champ clinique, décidé par ligne selon la portée
   * de `consultations:consultation:read` (site du rendez-vous ou service du praticien).
   */
  private viewOptions(): (row: AppointmentRow) => ViewOptions {
    const scope = this.scopeOf('consultations:consultation:read');
    return (row) => ({ includeClinical: isWithinScope(scope, { siteId: row.siteId, departmentId: row.practitioner.departmentId }) });
  }

  private view(row: AppointmentRow): AppointmentView {
    return toAppointmentView(row, this.viewOptions()(row));
  }

  /** Reprogrammer exige de voir le patient (périmètre `patients:patient:read`) ; sinon 404, comme un rendez-vous inconnu. */
  private async requirePatientInScope(tx: TenantTx, tenantId: string, row: AppointmentRow): Promise<void> {
    const scope = this.scopeOf('patients:patient:read');
    const departmentSites = scope.allTenant ? [] : await this.repo.siteIdsOfDepartments(tx, tenantId, scope.departmentIds);
    if (!isPatientWithinScope(scope, row.patient.primarySiteId, departmentSites)) throw DomainError.notFound('Rendez-vous');
  }

  private scopeOf(permission: PermissionKey): PermissionScope {
    return scopesFor(permission, this.context.grants);
  }

  /** Hors portée ⇒ 404 : on ne révèle pas l'existence d'un rendez-vous d'un site non autorisé. */
  private async requireInScope(tx: TenantTx, tenantId: string, id: string, scope: PermissionScope): Promise<AppointmentRow> {
    const row = await this.repo.findById(tx, tenantId, id);
    if (!row || !isWithinScope(scope, { siteId: row.siteId, departmentId: row.practitioner.departmentId })) {
      throw DomainError.notFound('Rendez-vous');
    }
    return row;
  }
}

function refNotFound(path: string, message: string): DomainError {
  return DomainError.validation([{ path, code: 'not_found', message }]);
}

function concurrentUpdate(): DomainError {
  return DomainError.conflict('concurrent_update', 'Le rendez-vous a été modifié entre-temps, réessayez.');
}

function assertRange(from: Date, to: Date): void {
  if (to <= from) throw DomainError.validation([{ path: 'to', code: 'invalid_range', message: 'to doit être postérieur à from.' }]);
  if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * MS_PER_DAY) {
    throw DomainError.validation([{ path: 'to', code: 'range_too_large', message: `L’intervalle ne peut dépasser ${MAX_RANGE_DAYS} jours.` }]);
  }
}
