import { Injectable } from '@nestjs/common';
import type { PermissionKey } from '@ghmt/shared';
import type { CreatePatientInput, DeletePatientInput, SearchPatientsInput, UpdatePatientInput } from '@ghmt/shared';
import type { Prisma } from '../../../generated/prisma/client';
import { AuditService } from '../../../common/audit/audit.service';
import { scopesFor } from '../../../common/authz/authorization.service';
import { RequestContext } from '../../../common/context/request-context';
import { FieldCrypto } from '../../../common/crypto/field-crypto.service';
import { DomainError } from '../../../common/errors/domain-error';
import { Page, decodeUuidCursor } from '../../../common/pagination/page';
import { Clock } from '../../../common/time/clock';
import { localDateKey } from '../../../common/time/local-date';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { loadTenantProfile } from '../../../infrastructure/tenancy/tenant-profile';
import { birthYearWindow, buildSearchName, buildSwappedSearchName, formatIpp, normalizeNationalId, toSearchPattern } from '../domain/patient-identity';
import { buildPatientScopeFilter, isPatientWithinScope, isSiteWithinPatientScope } from '../domain/patient-scope';
import {
  toDuplicateCandidate,
  toPatientDetail,
  toPatientSummary,
  type PatientDetail,
  type PatientRow,
  type PatientSummary,
} from '../mappers/patient.mapper';
import { resetSmsConsentOnPhoneChange } from './phone-change-consent';
import { PatientsRepository, type DuplicateMatches } from '../repositories/patients.repository';

const MIN_SEARCH_LENGTH = 2;
const SEARCH_CRITERIA = ['q', 'phone', 'ipp'] as const;
const APPOINTMENT_CANCEL_REASON_ON_DELETE = 'patient_record_deleted';

type DuplicateOutcome =
  | { readonly kind: 'duplicate'; readonly matches: DuplicateMatches; readonly criteria: readonly string[] }
  | { readonly kind: 'created'; readonly patient: PatientDetail };

type SensitiveField = 'phone' | 'email' | 'nationalId' | 'address';

@Injectable()
export class PatientsService {
  constructor(
    private readonly db: TenantDb,
    private readonly repo: PatientsRepository,
    private readonly crypto: FieldCrypto,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
    private readonly clock: Clock,
  ) {}

  async create(input: CreatePatientInput, force: boolean): Promise<PatientDetail> {
    const { tenantId, userId } = this.context.requirePrincipal();
    const { forceReason, ...fields } = input;
    if (force && !forceReason) {
      throw DomainError.unprocessable('force_reason_required', 'Un motif est obligatoire pour créer un patient malgré un doublon probable.');
    }
    const outcome = await this.db.run<DuplicateOutcome>(async (tx) => {
      if (fields.primarySiteId) {
        await this.assertSiteExists(tx, tenantId, fields.primarySiteId);
        await this.assertSiteInScope(tx, tenantId, 'patients:patient:create', fields.primarySiteId);
      }
      if (fields.birthDate) await this.assertBirthDateNotFuture(tx, fields.birthDate);
      if (!force) {
        // Le doublon est renvoyé comme résultat (pas levé) : sa trace d'audit est validée dans une transaction distincte.
        const duplicate = await this.findProbableDuplicate(tx, tenantId, fields);
        if (duplicate) return duplicate;
      }

      const ipp = formatIpp(await this.repo.nextIppSequence(tx));
      const row = await this.repo.create(tx, {
        tenantId,
        ipp,
        lastName: fields.lastName,
        firstName: fields.firstName,
        searchName: buildSearchName(fields.lastName, fields.firstName),
        birthDate: fields.birthDate ? new Date(fields.birthDate) : undefined,
        birthDateEstimated: fields.birthDateEstimated,
        sex: fields.sex,
        bloodGroup: fields.bloodGroup,
        city: fields.city,
        primarySiteId: fields.primarySiteId,
        ...this.sensitiveColumns(tenantId, fields),
        createdBy: userId,
        updatedBy: userId,
      });
      await this.audit.record(tx, tenantId, {
        action: 'patient.created',
        resourceType: 'patient',
        resourceId: row.id,
        patientId: row.id,
        changes: {
          fields: Object.keys(fields).filter((key) => fields[key as keyof typeof fields] !== undefined),
          forced: force,
          // Le motif est une justification libre de l'utilisateur, sans donnée du patient créé.
          ...(force ? { forceReason } : {}),
        },
      });
      return { kind: 'created', patient: await this.detailOf(tx, tenantId, row) };
    });
    if (outcome.kind === 'created') return outcome.patient;
    return this.auditAndRaiseDuplicate(tenantId, outcome);
  }

  search(input: SearchPatientsInput): Promise<Page<PatientSummary>> {
    const { tenantId } = this.context.requirePrincipal();
    if (SEARCH_CRITERIA.every((key) => input[key] === undefined)) {
      throw DomainError.unprocessable('search_criteria_required', 'Au moins un critère de recherche est requis (q, phone ou ipp).');
    }
    const namePattern = input.q === undefined ? undefined : toSearchPattern(input.q);
    if (namePattern !== undefined && namePattern.length < MIN_SEARCH_LENGTH) {
      throw DomainError.validation([{ path: 'q', code: 'too_small', message: 'Le terme de recherche est trop court.' }]);
    }
    const afterId = decodeUuidCursor(input.cursor);
    return this.db.run(async (tx) => {
      const scope = await this.scopeFilter(tx, tenantId, 'patients:patient:read');
      const rows = await this.repo.search(tx, tenantId, {
        namePattern,
        phoneBidx: input.phone ? this.crypto.blindIndex(tenantId, input.phone) : undefined,
        ipp: input.ipp?.trim().toUpperCase(),
        afterId,
        take: input.limit + 1,
        scope,
      });
      const page = Page.fromRows(rows, input.limit, toPatientSummary, (row) => row.id);
      await this.audit.record(tx, tenantId, {
        action: 'patient.searched',
        resourceType: 'patient',
        // Jamais le terme recherché : les critères utilisés, le volume et les patients effectivement renvoyés.
        patientIds: page.items.map((item) => item.id),
        changes: { criteria: SEARCH_CRITERIA.filter((key) => input[key] !== undefined), resultCount: page.items.length },
      });
      return page;
    });
  }

  get(id: string): Promise<PatientDetail> {
    const { tenantId } = this.context.requirePrincipal();
    return this.db.run(async (tx) => {
      const scope = await this.scopeFilter(tx, tenantId, 'patients:patient:read');
      const row = await this.requirePatient(tx, tenantId, id, scope);
      await this.audit.record(tx, tenantId, { action: 'patient.read', resourceType: 'patient', resourceId: row.id, patientId: row.id });
      return this.detailOf(tx, tenantId, row);
    });
  }

  update(id: string, changes: UpdatePatientInput, expectedVersion: number): Promise<PatientDetail> {
    const { tenantId, userId } = this.context.requirePrincipal();
    const fields = Object.keys(changes).filter((key) => changes[key as keyof UpdatePatientInput] !== undefined);
    if (fields.length === 0) {
      throw DomainError.validation([{ path: '', code: 'empty_update', message: 'Aucun champ à modifier.' }]);
    }
    return this.db.run(async (tx) => {
      const scope = await this.scopeFilter(tx, tenantId, 'patients:patient:update');
      const current = await this.requirePatient(tx, tenantId, id, scope);
      if (changes.primarySiteId) {
        await this.assertSiteExists(tx, tenantId, changes.primarySiteId);
        await this.assertSiteInScope(tx, tenantId, 'patients:patient:update', changes.primarySiteId);
      }
      if (changes.birthDate) await this.assertBirthDateNotFuture(tx, changes.birthDate);
      const birthDateEstimated = this.resolveBirthDateEstimated(current, changes);

      const lastName = changes.lastName ?? current.lastName;
      const firstName = changes.firstName ?? current.firstName;
      const updated = await this.repo.update(tx, tenantId, id, expectedVersion, {
        ...(changes.lastName !== undefined || changes.firstName !== undefined
          ? { lastName, firstName, searchName: buildSearchName(lastName, firstName) }
          : {}),
        ...(changes.birthDate !== undefined ? { birthDate: new Date(changes.birthDate) } : {}),
        ...(birthDateEstimated !== undefined ? { birthDateEstimated } : {}),
        ...(changes.sex !== undefined ? { sex: changes.sex } : {}),
        ...(changes.bloodGroup !== undefined ? { bloodGroup: changes.bloodGroup } : {}),
        ...(changes.city !== undefined ? { city: changes.city } : {}),
        ...(changes.primarySiteId !== undefined ? { primarySiteId: changes.primarySiteId } : {}),
        ...this.sensitiveColumns(tenantId, changes),
        updatedBy: userId,
      });
      if (updated === 0) throw this.versionMismatch(current.rowVersion);
      if (changes.phone !== undefined && !sameBytes(current.phoneBidx, changes.phone === null ? null : this.crypto.blindIndex(tenantId, changes.phone))) {
        await resetSmsConsentOnPhoneChange(tx, this.audit, { tenantId, patientId: id, actorId: userId, now: this.clock.now() });
      }
      await this.audit.record(tx, tenantId, {
        action: 'patient.updated',
        resourceType: 'patient',
        resourceId: id,
        patientId: id,
        // Liste des champs modifiés, jamais leurs valeurs.
        changes: { fields },
      });
      return this.detailOf(tx, tenantId, await this.requirePatient(tx, tenantId, id, {}));
    });
  }

  remove(id: string, input: DeletePatientInput, expectedVersion: number): Promise<void> {
    const { tenantId, userId } = this.context.requirePrincipal();
    return this.db.run(async (tx) => {
      const scope = await this.scopeFilter(tx, tenantId, 'patients:patient:delete');
      const current = await this.requirePatient(tx, tenantId, id, scope);
      const count = await this.repo.softDelete(tx, tenantId, id, expectedVersion, userId);
      if (count === 0) throw this.versionMismatch(current.rowVersion);
      // Un dossier supprimé ne doit plus avoir de rendez-vous à venir : annulation dans la même transaction.
      const cancelledAppointmentIds = await this.repo.cancelFutureAppointments(
        tx,
        tenantId,
        id,
        this.clock.now(),
        userId,
        APPOINTMENT_CANCEL_REASON_ON_DELETE,
      );
      await this.audit.record(tx, tenantId, {
        action: 'patient.deleted',
        resourceType: 'patient',
        resourceId: id,
        patientId: id,
        changes: { reason: input.reason, cancelledAppointmentIds },
      });
    });
  }

  /**
   * Projection complète si le dossier est dans la portée de `patients:patient:update` (décision par patient),
   * « identité seule » sinon.
   */
  private async detailOf(tx: TenantTx, tenantId: string, row: PatientRow): Promise<PatientDetail> {
    const scope = scopesFor('patients:patient:update', this.context.grants);
    const departmentSites = scope.allTenant ? [] : await this.repo.siteIdsOfDepartments(tx, tenantId, scope.departmentIds);
    const includeContact = isPatientWithinScope(scope, row.primarySiteId, departmentSites);
    return toPatientDetail(row, this.crypto, { includeContact });
  }

  /** Contrôle exact « date de naissance ≤ aujourd'hui » dans le fuseau de l'établissement (le schéma partagé tolère +1 jour UTC). */
  private async assertBirthDateNotFuture(tx: TenantTx, birthDate: string): Promise<void> {
    const { timezone } = await loadTenantProfile(tx);
    if (birthDate > localDateKey(this.clock.now(), timezone)) {
      throw DomainError.validation([{ path: 'birthDate', code: 'birth_date_in_future', message: 'La date de naissance ne peut pas être dans le futur.' }]);
    }
  }

  private versionMismatch(currentVersion: number): DomainError {
    return DomainError.preconditionFailed('Le dossier a été modifié entre-temps.', [
      { path: 'If-Match', code: 'version_mismatch', message: `Version courante : ${currentVersion}.` },
    ]);
  }

  /** Indicateur « date estimée » à enregistrer : modifier la date sans l'indicateur le remet à faux ; vrai exige une date. */
  private resolveBirthDateEstimated(current: PatientRow, changes: UpdatePatientInput): boolean | undefined {
    const estimated = changes.birthDateEstimated ?? (changes.birthDate !== undefined ? false : undefined);
    const birthDate = changes.birthDate ?? current.birthDate;
    if (estimated === true && !birthDate) {
      throw DomainError.validation([{ path: 'birthDateEstimated', code: 'birth_date_required', message: 'Une date de naissance est requise pour la marquer comme estimée.' }]);
    }
    return estimated;
  }

  private async findProbableDuplicate(tx: TenantTx, tenantId: string, input: Omit<CreatePatientInput, 'forceReason'>): Promise<DuplicateOutcome | undefined> {
    const birthDate = input.birthDate ? new Date(input.birthDate) : undefined;
    const matches = await this.repo.findDuplicates(
      tx,
      tenantId,
      {
        nameKeys: [...new Set([buildSearchName(input.lastName, input.firstName), buildSwappedSearchName(input.lastName, input.firstName)])],
        birthDate,
        birthDateEstimated: input.birthDateEstimated,
        birthYearWindow: birthDate ? birthYearWindow(birthDate) : undefined,
        phoneBidx: input.phone ? this.crypto.blindIndex(tenantId, input.phone) : undefined,
        nationalIdBidx: input.nationalId ? this.crypto.blindIndex(tenantId, normalizeNationalId(input.nationalId)) : undefined,
      },
      await this.scopeFilter(tx, tenantId, 'patients:patient:read'),
    );
    if (matches.visible.length === 0 && matches.hiddenIds.length === 0) return undefined;
    // Types de critères seulement, jamais leurs valeurs.
    const criteria = ['name', ...(input.birthDate ? ['birthDate'] : []), ...(input.phone ? ['phone'] : []), ...(input.nationalId ? ['nationalId'] : [])];
    return { kind: 'duplicate', matches, criteria };
  }

  /**
   * Audite la détection dans une transaction séparée et validée (la levée du 409 n'annule alors pas la trace),
   * puis lève : 409 `patient_duplicate` (candidats visibles) ou `patient_duplicate_out_of_scope` (aucun détail).
   */
  private async auditAndRaiseDuplicate(tenantId: string, outcome: Extract<DuplicateOutcome, { kind: 'duplicate' }>): Promise<never> {
    const { matches, criteria } = outcome;
    const outOfScope = matches.visible.length === 0;
    await this.db.run((tx) =>
      this.audit.record(tx, tenantId, {
        action: outOfScope ? 'patient.duplicate_out_of_scope' : 'patient.duplicate_detected',
        resourceType: 'patient',
        outcome: 'success',
        patientIds: outOfScope ? matches.hiddenIds : matches.visible.map((candidate) => candidate.id),
        changes: { criteria },
      }),
    );
    if (outOfScope) {
      throw DomainError.conflict('patient_duplicate_out_of_scope', 'Un patient correspondant existe probablement déjà, hors de votre périmètre.');
    }
    throw DomainError.conflict('patient_duplicate', 'Un patient correspondant existe probablement déjà.', {
      details: { candidates: matches.visible.map(toDuplicateCandidate) },
    });
  }

  private async requirePatient(tx: TenantTx, tenantId: string, id: string, scope: Prisma.PatientWhereInput): Promise<PatientRow> {
    const row = await this.repo.findById(tx, tenantId, id, scope);
    if (!row) throw DomainError.notFound('Patient');
    return row;
  }

  private async assertSiteExists(tx: TenantTx, tenantId: string, siteId: string): Promise<void> {
    if (!(await this.repo.siteExists(tx, tenantId, siteId))) {
      throw DomainError.validation([{ path: 'primarySiteId', code: 'not_found', message: 'Site introuvable.' }]);
    }
  }

  /** Périmètre de la permission sous forme de filtre sur `primarySiteId` (A6). */
  private async scopeFilter(tx: TenantTx, tenantId: string, permission: PermissionKey): Promise<Prisma.PatientWhereInput> {
    const scope = scopesFor(permission, this.context.grants);
    const departmentSites = scope.allTenant ? [] : await this.repo.siteIdsOfDepartments(tx, tenantId, scope.departmentIds);
    return buildPatientScopeFilter(scope, departmentSites);
  }

  private async assertSiteInScope(tx: TenantTx, tenantId: string, permission: PermissionKey, siteId: string): Promise<void> {
    const scope = scopesFor(permission, this.context.grants);
    const departmentSites = scope.allTenant ? [] : await this.repo.siteIdsOfDepartments(tx, tenantId, scope.departmentIds);
    if (!isSiteWithinPatientScope(scope, siteId, departmentSites)) {
      throw DomainError.forbidden('site_out_of_scope', 'Ce site est hors de votre périmètre.', permission);
    }
  }

  /**
   * Colonnes chiffrées + index aveugles pour les champs sensibles présents dans l'entrée.
   * `null` efface la valeur et son index.
   */
  private sensitiveColumns(
    tenantId: string,
    input: Partial<Record<SensitiveField, string | null | undefined>>,
  ): Record<string, Uint8Array<ArrayBuffer> | null> {
    const out: Record<string, Uint8Array<ArrayBuffer> | null> = {};
    const apply = (value: string | null | undefined, encKey: string, bidxKey?: string, normalize: (raw: string) => string = (raw) => raw): void => {
      if (value === undefined) return;
      out[encKey] = value === null ? null : this.crypto.encrypt(tenantId, value);
      if (bidxKey) out[bidxKey] = value === null ? null : this.crypto.blindIndex(tenantId, normalize(value));
    };
    apply(input.phone, 'phoneEnc', 'phoneBidx');
    apply(input.email, 'emailEnc', 'emailBidx');
    apply(input.nationalId, 'nationalIdEnc', 'nationalIdBidx', normalizeNationalId);
    apply(input.address, 'addressEnc');
    return out;
  }
}

function sameBytes(left: Uint8Array | null, right: Uint8Array | null): boolean {
  if (left === null || right === null) return left === right;
  return Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;
}
