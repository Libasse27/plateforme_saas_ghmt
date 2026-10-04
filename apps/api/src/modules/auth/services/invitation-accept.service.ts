import { Injectable } from '@nestjs/common';
import type { InvitationPreview } from '@ghmt/shared';
import { parseOpaqueToken, type ParsedOpaqueToken } from '../../../common/auth/opaque-token';
import { PasswordService } from '../../../common/auth/password.service';
import { AuditService } from '../../../common/audit/audit.service';
import { DomainError } from '../../../common/errors/domain-error';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { loadTenantProfile } from '../../../infrastructure/tenancy/tenant-profile';

function invitationExpired(): DomainError {
  // Même réponse pour un jeton inconnu, mal formé, expiré ou déjà utilisé : aucun oracle.
  return DomainError.gone('invitation_expired', 'Cette invitation est expirée ou n’est plus valide.');
}

interface PendingInvitation {
  readonly userId: string;
  readonly email: string;
  readonly fullName: string;
}

/** Parties publiques du flux d'invitation (C6) : aperçu puis acceptation avec choix du mot de passe. */
@Injectable()
export class InvitationAcceptService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
  ) {}

  async preview(rawToken: string): Promise<InvitationPreview> {
    const parsed = parseOpaqueToken(rawToken);
    if (!parsed) throw invitationExpired();
    const result = await this.tenantDb.runAs(parsed.tenantId, async (tx) => {
      const pending = await this.findPending(tx, parsed);
      if (!pending) return undefined;
      const profile = await loadTenantProfile(tx);
      return { email: pending.email, fullName: pending.fullName, tenantName: profile.name };
    });
    if (!result) throw invitationExpired();
    return result;
  }

  async accept(rawToken: string, password: string): Promise<void> {
    const parsed = parseOpaqueToken(rawToken);
    if (!parsed) throw invitationExpired();
    const { tenantId } = parsed;

    const valid = await this.tenantDb.runAs(tenantId, async (tx) => (await this.findPending(tx, parsed)) !== undefined);
    if (!valid) throw invitationExpired();
    const passwordHash = await this.passwords.hash(password);

    const accepted = await this.tenantDb.runAs(tenantId, async (tx) => {
      const pending = await this.findPending(tx, parsed);
      if (!pending) return false;
      // Consommation atomique : deux acceptations concurrentes ne peuvent pas toutes deux réussir.
      const claimed = await tx.invitation.updateMany({
        where: { tenantId, tokenHash: parsed.hash, consumedAt: null },
        data: { consumedAt: new Date() },
      });
      if (claimed.count === 0) return false;

      const now = new Date();
      await tx.userCredential.upsert({
        where: { tenantId_userId: { tenantId, userId: pending.userId } },
        create: { tenantId, userId: pending.userId, passwordHash, mustChangePassword: false },
        update: { passwordHash, passwordChangedAt: now, mustChangePassword: false, failedAttempts: 0, lockedUntil: null },
      });
      await tx.user.update({
        where: { tenantId_id: { tenantId, id: pending.userId } },
        data: { status: 'active', emailVerifiedAt: now, rowVersion: { increment: 1 } },
        select: { id: true },
      });
      await this.audit.record(tx, tenantId, {
        action: 'iam.user.invitation_accepted',
        actorUserId: pending.userId,
        resourceType: 'user',
        resourceId: pending.userId,
        changes: { after: { status: 'active' } },
      });
      return true;
    });
    if (!accepted) throw invitationExpired();
  }

  /** Invitation non consommée, non expirée, d'un utilisateur encore « invité ». */
  private async findPending(tx: TenantTx, parsed: ParsedOpaqueToken): Promise<PendingInvitation | undefined> {
    const invitation = await tx.invitation.findUnique({
      where: { tenantId_tokenHash: { tenantId: parsed.tenantId, tokenHash: parsed.hash } },
      select: { userId: true, consumedAt: true, expiresAt: true, user: { select: { email: true, fullName: true, status: true, deletedAt: true } } },
    });
    if (!invitation || invitation.consumedAt || invitation.expiresAt <= new Date()) return undefined;
    if (invitation.user.status !== 'invited' || invitation.user.deletedAt) return undefined;
    return { userId: invitation.userId, email: invitation.user.email, fullName: invitation.user.fullName };
  }
}
