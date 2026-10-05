import { Injectable } from '@nestjs/common';
import type { ContactConsentsView, RecordContactConsentInput } from '@ghmt/shared';
import { AuditService } from '../../../common/audit/audit.service';
import { scopesFor } from '../../../common/authz/authorization.service';
import { RequestContext } from '../../../common/context/request-context';
import { DomainError } from '../../../common/errors/domain-error';
import { Clock } from '../../../common/time/clock';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { isPatientWithinScope } from '../../patients/domain/patient-scope';
import { AppointmentPlanningService } from './appointment-planning.service';
import { toConsentsView } from '../mappers/consent.mapper';
import { ConsentsRepository } from '../repositories/consents.repository';
import { NotificationsRepository } from '../repositories/notifications.repository';
import { RecipientsRepository } from '../repositories/recipients.repository';

/** Consentement du patient aux rappels (docs/10 §5.6, D10) : état courant, historique en ajout seul, effet immédiat. */
@Injectable()
export class ConsentsService {
  constructor(
    private readonly db: TenantDb,
    private readonly consents: ConsentsRepository,
    private readonly notifications: NotificationsRepository,
    private readonly recipients: RecipientsRepository,
    private readonly planning: AppointmentPlanningService,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
    private readonly clock: Clock,
  ) {}

  get(patientId: string): Promise<ContactConsentsView> {
    const { tenantId } = this.context.requirePrincipal();
    return this.db.run(async (tx) => {
      await this.requirePatientInScope(tx, tenantId, patientId);
      await this.audit.record(tx, tenantId, { action: 'patient.consents_read', resourceType: 'patient', resourceId: patientId, patientId });
      return this.view(tx, tenantId, patientId);
    });
  }

  record(patientId: string, input: RecordContactConsentInput): Promise<ContactConsentsView> {
    const { tenantId, userId } = this.context.requirePrincipal();
    const now = this.clock.now();
    return this.db.run(async (tx) => {
      await this.requirePatientInScope(tx, tenantId, patientId);
      await this.consents.record(tx, tenantId, { patientId, channel: input.channel, granted: input.granted, source: input.source, recordedBy: userId });
      await this.audit.record(tx, tenantId, {
        action: 'patient.consent_changed',
        resourceType: 'patient',
        resourceId: patientId,
        patientId,
        changes: { channel: input.channel, purpose: input.purpose, granted: input.granted, source: input.source },
      });
      // Effet immédiat, dans la même transaction : un retrait supprime les rappels en attente, un octroi ré-arme les futurs.
      if (input.granted) {
        await this.planning.replanPatientReminders(tx, tenantId, patientId, now, 'reactivate_no_consent');
        await this.notifications.suppressDuplicateChannelReminders(tx, tenantId, patientId, now);
      } else {
        await this.notifications.suppressPatientReminders(tx, tenantId, patientId, input.channel, now);
        await this.planning.replanPatientReminders(tx, tenantId, patientId, now, 'skip');
      }
      return this.view(tx, tenantId, patientId);
    });
  }

  private async view(tx: TenantTx, tenantId: string, patientId: string): Promise<ContactConsentsView> {
    const current = await this.consents.latestByChannel(tx, tenantId, patientId);
    return toConsentsView(patientId, current, await this.consents.history(tx, tenantId, patientId));
  }

  /** Patient inconnu, d'un autre établissement ou hors du périmètre de `patients:patient:read` ⇒ 404. */
  private async requirePatientInScope(tx: TenantTx, tenantId: string, patientId: string): Promise<void> {
    const patient = await tx.patient.findFirst({ where: { tenantId, id: patientId, deletedAt: null }, select: { primarySiteId: true } });
    const scope = scopesFor('patients:patient:read', this.context.grants);
    const departmentSites = scope.allTenant ? [] : await this.recipients.siteIdsOfDepartments(tx, tenantId, scope.departmentIds);
    if (!patient || !isPatientWithinScope(scope, patient.primarySiteId, departmentSites)) throw DomainError.notFound('Patient');
  }
}
