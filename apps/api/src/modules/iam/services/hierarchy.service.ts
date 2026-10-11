import { Injectable } from '@nestjs/common';
import { AuthorizationService } from '../../../common/authz/authorization.service';
import { RequestContext } from '../../../common/context/request-context';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { adminRank, assertCanManage, type AdminRank, type RankedUser } from './admin-hierarchy';

/** Chargement des rangs (docs/11 D9) dans la transaction de l'appelant. */
@Injectable()
export class HierarchyService {
  constructor(
    private readonly authz: AuthorizationService,
    private readonly context: RequestContext,
  ) {}

  /** Identifiant de l'administrateur principal, ou `null`. */
  async ownerId(tx: TenantTx): Promise<string | null> {
    const settings = await tx.securitySettings.findFirst({ select: { ownerUserId: true } });
    return settings?.ownerUserId ?? null;
  }

  async rankOf(tx: TenantTx, userId: string, ownerUserId?: string | null): Promise<RankedUser> {
    const owner = ownerUserId === undefined ? await this.ownerId(tx) : ownerUserId;
    const grants = await this.authz.loadGrants(tx, userId);
    return { userId, rank: adminRank({ isOwner: owner === userId, permissions: grants.map((g) => g.permission) }) };
  }

  async actor(tx: TenantTx): Promise<RankedUser> {
    return this.rankOf(tx, this.context.requirePrincipal().userId);
  }

  /** 403 `admin_hierarchy` si l'acteur courant ne peut pas agir sur `targetUserId`. Renvoie les rangs pour d'autres contrôles. */
  async assertCanManageUser(tx: TenantTx, targetUserId: string): Promise<{ actor: RankedUser; target: RankedUser; ownerUserId: string | null }> {
    const ownerUserId = await this.ownerId(tx);
    const actor = await this.rankOf(tx, this.context.requirePrincipal().userId, ownerUserId);
    const target = await this.rankOf(tx, targetUserId, ownerUserId);
    assertCanManage(actor, target);
    return { actor, target, ownerUserId };
  }

  async actorRank(tx: TenantTx): Promise<AdminRank> {
    return (await this.actor(tx)).rank;
  }
}
