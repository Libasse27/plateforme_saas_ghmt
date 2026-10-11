import { Injectable } from '@nestjs/common';
import {
  TRUSTED_NETWORK_MAX,
  type CreateTrustedNetworkInput,
  type SecurityPolicyView,
  type TrustedNetworkView,
  type UpdateSecurityPolicyInput,
} from '@ghmt/shared';
import { AuditService } from '../../../common/audit/audit.service';
import { type Principal, RequestContext } from '../../../common/context/request-context';
import { DomainError } from '../../../common/errors/domain-error';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { TOTP_KIND } from '../../auth/auth.constants';
import { SecurityAlertService, type EstablishmentAlertType } from '../../notifications/services/security-alert.service';
import { holdsActiveAdminRole, lockSecuritySettings } from './admin-invariant';
import { HierarchyService } from './hierarchy.service';
import { SecurityPolicyReader, toCidr } from './security-policy.reader';
import { StepUpService } from './step-up.service';
import { parseTrustedCidr } from './trusted-cidr';

export { toCidr } from './security-policy.reader';

/** Politique de sécurité de l'établissement : MFA des soignants, réseaux de confiance, administrateur principal (docs/11 §5.4, §14.1). */
@Injectable()
export class SecurityService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
    private readonly hierarchy: HierarchyService,
    private readonly stepUp: StepUpService,
    private readonly alerts: SecurityAlertService,
    private readonly reader: SecurityPolicyReader,
  ) {}

  getPolicy(): Promise<SecurityPolicyView> {
    return this.tenantDb.run((tx) => this.reader.view(tx));
  }

  async updatePolicy(input: UpdateSecurityPolicyInput): Promise<SecurityPolicyView> {
    const principal = this.context.requirePrincipal();
    await this.stepUp.confirm(principal, input.totpCode, (tx) => this.assertOwner(tx, principal));
    return this.tenantDb.run(async (tx) => {
      await this.assertOwner(tx, principal);
      await tx.securitySettings.upsert({
        where: { tenantId: principal.tenantId },
        create: { tenantId: principal.tenantId, clinicalMfaMode: input.clinicalMfa, updatedBy: principal.userId },
        update: { clinicalMfaMode: input.clinicalMfa, updatedBy: principal.userId, updatedAt: new Date() },
      });
      await this.audit.record(tx, principal.tenantId, { action: 'iam.security.policy_updated', resourceType: 'security_settings', changes: { clinicalMfa: input.clinicalMfa } });
      await this.alert(tx, principal, 'security.policy_changed');
      return this.reader.view(tx);
    });
  }

  async addNetwork(input: CreateTrustedNetworkInput): Promise<TrustedNetworkView> {
    const principal = this.context.requirePrincipal();
    // Contrôles avant le code : une faute de frappe, un doublon ou la limite atteinte ne consomment pas de code TOTP. Ils sont
    // refaits dans la transaction de l'opération (le code, lui, reste consommé même si elle échoue).
    const parsed = parseTrustedCidr(input.cidr);
    await this.stepUp.confirm(principal, input.totpCode, async (tx) => {
      await this.assertOwner(tx, principal);
      await this.assertCanAdd(tx, parsed.network);
    });
    return this.tenantDb.run(async (tx) => {
      await this.assertOwner(tx, principal);
      await this.assertCanAdd(tx, parsed.network);
      const created = await tx.trustedNetwork.create({
        data: { tenantId: principal.tenantId, network: parsed.network, label: input.label, createdBy: principal.userId },
        select: { id: true },
      });
      await this.audit.record(tx, principal.tenantId, {
        action: 'iam.security.trusted_network_added',
        resourceType: 'trusted_network',
        resourceId: created.id,
        changes: { cidr: parsed.network, label: input.label },
      });
      await this.alert(tx, principal, 'security.trusted_network_changed');
      return (await this.reader.networks(tx)).find((n) => n.id === created.id)!;
    });
  }

  async removeNetwork(id: string, totpCode: string | undefined): Promise<void> {
    const principal = this.context.requirePrincipal();
    await this.stepUp.confirm(principal, totpCode, (tx) => this.assertOwner(tx, principal));
    await this.tenantDb.run(async (tx) => {
      await this.assertOwner(tx, principal);
      const row = await tx.trustedNetwork.findFirst({ where: { id, deletedAt: null }, select: { network: true, label: true } });
      const removed = row ? await tx.trustedNetwork.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: new Date() } }) : { count: 0 };
      if (!row || removed.count === 0) throw DomainError.notFound('Plage réseau');
      await this.audit.record(tx, principal.tenantId, {
        action: 'iam.security.trusted_network_removed',
        resourceType: 'trusted_network',
        resourceId: id,
        changes: { cidr: toCidr(row.network), label: row.label },
      });
      await this.alert(tx, principal, 'security.trusted_network_changed');
    });
  }

  /** Transfert du titre d'administrateur principal : par le principal seul (code TOTP), vers un administrateur actif ayant un TOTP actif. */
  async transferOwnership(targetUserId: string, totpCode: string | undefined): Promise<SecurityPolicyView> {
    const principal = this.context.requirePrincipal();
    const assertTransferable = async (tx: TenantTx): Promise<void> => {
      await this.assertOwner(tx, principal, 'Seul l’administrateur principal peut transférer ce titre.');
      await this.assertValidTarget(tx, principal.userId, targetUserId);
    };
    await this.stepUp.confirm(principal, totpCode, assertTransferable);
    return this.tenantDb.run(async (tx) => {
      // Verrou de ligne : deux transferts concurrents, ou un transfert et une désactivation, sont sérialisés. La cible est
      // revérifiée (toujours active et administratrice) APRÈS le verrou.
      await lockSecuritySettings(tx, principal.tenantId);
      await assertTransferable(tx);
      await tx.securitySettings.update({
        where: { tenantId: principal.tenantId },
        data: { ownerUserId: targetUserId, updatedBy: principal.userId, updatedAt: new Date() },
      });
      await this.audit.record(tx, principal.tenantId, {
        action: 'iam.owner.transferred',
        resourceType: 'user',
        resourceId: targetUserId,
        changes: { fromUserId: principal.userId, toUserId: targetUserId },
      });
      // Le nouveau principal est prévenu lui aussi (il est la personne visée).
      await this.alerts.establishmentAlert(
        tx,
        principal.tenantId,
        'security.owner_transferred',
        { audience: 'directors_and_owner', actorUserId: principal.userId, targetUserId, include: [targetUserId] },
        new Date(),
      );
      return this.reader.view(tx);
    });
  }

  /** Opérations de pouvoir réservées au principal (décision 23) : 403 `owner_required`. */
  private async assertOwner(tx: TenantTx, principal: Principal, detail = 'Seul l’administrateur principal peut modifier la politique de sécurité.'): Promise<void> {
    if ((await this.hierarchy.ownerId(tx)) !== principal.userId) throw DomainError.forbidden('owner_required', detail);
  }

  private async assertCanAdd(tx: TenantTx, network: string): Promise<void> {
    if ((await tx.trustedNetwork.count({ where: { deletedAt: null } })) >= TRUSTED_NETWORK_MAX) {
      throw DomainError.unprocessable('trusted_network_limit', `Limite atteinte : ${TRUSTED_NETWORK_MAX} plages au plus par établissement.`);
    }
    const duplicates = await tx.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id FROM tenant.trusted_networks WHERE deleted_at IS NULL AND network = ${network}::inet`;
    if (duplicates.length > 0) throw DomainError.conflict('trusted_network_exists', 'Cette plage réseau est déjà déclarée.');
  }

  private async assertValidTarget(tx: TenantTx, actorId: string, targetUserId: string): Promise<void> {
    const invalid = (): DomainError =>
      DomainError.unprocessable('owner_target_invalid', 'Le nouvel administrateur principal doit être un autre administrateur actif ayant activé le second facteur.');
    if (targetUserId === actorId) throw invalid();
    const user = await tx.user.findFirst({
      where: { id: targetUserId, deletedAt: null, status: 'active' },
      select: { mfaFactors: { where: { kind: TOTP_KIND, activatedAt: { not: null } }, select: { id: true } } },
    });
    if (!user || user.mfaFactors.length === 0 || !(await holdsActiveAdminRole(tx, targetUserId))) throw invalid();
  }

  private async alert(tx: TenantTx, principal: Principal, typeCode: EstablishmentAlertType): Promise<void> {
    await this.alerts.establishmentAlert(tx, principal.tenantId, typeCode, { audience: 'directors_and_owner', actorUserId: principal.userId }, new Date());
  }
}
