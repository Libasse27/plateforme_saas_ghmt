import { Injectable } from '@nestjs/common';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { loadTenantProfile } from '../../../infrastructure/tenancy/tenant-profile';
import { LoginDelayService } from '../../auth/services/login-delay.service';
import { ASSIGNMENT_SELECT, USER_SELECT, toUserDetailDto, toUserDto, type UserRow } from '../mappers/iam.mappers';
import { HierarchyService } from './hierarchy.service';

/** Vues utilisateur enrichies (docs/11 §14.1) : principal, second facteur actif, connexion ralentie. */
@Injectable()
export class UserViewsService {
  constructor(
    private readonly hierarchy: HierarchyService,
    private readonly delay: LoginDelayService,
  ) {}

  async detail(tx: TenantTx, id: string) {
    const user = await tx.user.findFirstOrThrow({
      where: { id },
      select: { ...USER_SELECT, assignments: { where: { revokedAt: null }, select: ASSIGNMENT_SELECT, orderBy: { id: 'asc' } } },
    });
    const [ownerUserId, delayed] = await Promise.all([this.hierarchy.ownerId(tx), this.delayedIds(tx, [user])]);
    return toUserDetailDto(user, { ownerUserId, loginDelayed: delayed.has(user.id) });
  }

  /** Mappage d'une page de résultats (le délai est lu dans le stockage de limitation, un appel par utilisateur). */
  async mapper(tx: TenantTx, rows: readonly (UserRow & { readonly email: string })[]): Promise<(row: UserRow) => ReturnType<typeof toUserDto>> {
    const [ownerUserId, delayed] = await Promise.all([this.hierarchy.ownerId(tx), this.delayedIds(tx, rows)]);
    return (row) => toUserDto(row, { ownerUserId, loginDelayed: delayed.has(row.id) });
  }

  /** Utilisateurs dont la prochaine tentative de connexion est retardée (`retryAfterSeconds > 0`, décision 21). */
  private async delayedIds(tx: TenantTx, rows: readonly { readonly id: string; readonly email: string }[]): Promise<ReadonlySet<string>> {
    if (rows.length === 0) return new Set();
    const { slug } = await loadTenantProfile(tx);
    const now = new Date();
    const delays = await Promise.all(rows.map(async (row) => ({ id: row.id, seconds: await this.delay.retryAfterSeconds(slug, row.email, now) })));
    return new Set(delays.filter((d) => d.seconds > 0).map((d) => d.id));
  }
}
