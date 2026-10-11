import { Injectable } from '@nestjs/common';
import { isClinicalPermission, type SecurityPolicyView, type TrustedNetworkView } from '@ghmt/shared';
import { AuthorizationService } from '../../../common/authz/authorization.service';
import { normalizeClientIp } from '../../../common/authz/client-ip';
import { RequestContext } from '../../../common/context/request-context';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { TOTP_KIND } from '../../auth/auth.constants';

interface NetworkRow {
  readonly id: string;
  readonly network: string;
  readonly label: string;
  readonly createdAt: Date;
  readonly createdBy: string | null;
}

/** `203.0.113.7` (forme d'affichage d'une adresse seule par PostgreSQL) ⇒ `203.0.113.7/32`. */
export function toCidr(network: string): string {
  if (network.includes('/')) return network;
  return `${network}/${network.includes(':') ? 128 : 32}`;
}

const MODES_DEFAULT = 'off_network' as const;

/** Lecture de la politique de sécurité (vue `SecurityPolicyView`, docs/11 §5.4 et §14.1). */
@Injectable()
export class SecurityPolicyReader {
  constructor(
    private readonly context: RequestContext,
    private readonly authz: AuthorizationService,
  ) {}

  async view(tx: TenantTx): Promise<SecurityPolicyView> {
    const settings = await tx.securitySettings.findFirst();
    const requestIp = normalizeClientIp(this.context.state?.ip);
    const ownerUserId = settings?.ownerUserId ?? null;
    const [trustedNetworks, network, owner, clinicalUsersWithoutMfa] = await Promise.all([
      this.networks(tx),
      this.authz.loadNetworkPolicy(tx, requestIp),
      ownerUserId ? tx.user.findFirst({ where: { id: ownerUserId }, select: { id: true, fullName: true } }) : null,
      this.countClinicalUsersWithoutMfa(tx, new Date()),
    ]);
    return {
      clinicalMfa: settings?.clinicalMfaMode === 'always' ? 'always' : MODES_DEFAULT,
      trustedNetworks,
      requestIp,
      requestIpTrusted: network.networkTrusted,
      clinicalUsersWithoutMfa,
      canManage: ownerUserId !== null && ownerUserId === this.context.principal?.userId,
      owner: owner ? { id: owner.id, fullName: owner.fullName } : null,
      updatedAt: settings?.updatedAt.toISOString() ?? null,
    };
  }

  async networks(tx: TenantTx): Promise<TrustedNetworkView[]> {
    const rows = await tx.$queryRaw<NetworkRow[]>`
      SELECT n.id::text AS id, host(n.network) || '/' || masklen(n.network) AS network, n.label,
             n.created_at AS "createdAt", n.created_by::text AS "createdBy"
      FROM tenant.trusted_networks n WHERE n.deleted_at IS NULL ORDER BY n.created_at, n.id`;
    const creatorIds = [...new Set(rows.map((r) => r.createdBy).filter((id): id is string => id !== null))];
    const creators = await tx.user.findMany({ where: { id: { in: creatorIds } }, select: { id: true, fullName: true } });
    const names = new Map(creators.map((u) => [u.id, u.fullName]));
    return rows.map((row) => ({
      id: row.id,
      cidr: toCidr(row.network),
      label: row.label,
      createdAt: row.createdAt.toISOString(),
      createdBy: row.createdBy ? { id: row.createdBy, fullName: names.get(row.createdBy) ?? '' } : null,
    }));
  }

  /** Utilisateurs actifs portant au moins une permission clinique effective (D5, décision 22) et sans TOTP actif. */
  async countClinicalUsersWithoutMfa(tx: TenantTx, now: Date): Promise<number> {
    const codes = await tx.rolePermission.findMany({ where: { role: { deletedAt: null } }, distinct: ['permissionCode'], select: { permissionCode: true } });
    const clinical = codes.map((c) => c.permissionCode).filter(isClinicalPermission);
    if (clinical.length === 0) return 0;
    return tx.user.count({
      where: {
        deletedAt: null,
        status: 'active',
        mfaFactors: { none: { kind: TOTP_KIND, activatedAt: { not: null } } },
        assignments: {
          some: {
            revokedAt: null,
            validFrom: { lte: now },
            OR: [{ validUntil: null }, { validUntil: { gt: now } }],
            role: { deletedAt: null, permissions: { some: { permissionCode: { in: clinical } } } },
          },
        },
      },
    });
  }
}
