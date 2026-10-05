import { Injectable } from '@nestjs/common';
import type { PlatformPasswordChangeInput } from '@ghmt/shared';
import { PlatformAuditService } from '../../../common/audit/platform-audit.service';
import { PasswordService } from '../../../common/auth/password.service';
import { DomainError } from '../../../common/errors/domain-error';
import { Clock } from '../../../common/time/clock';
import { PlatformDb } from '../../../infrastructure/prisma/platform-db.service';
import type { PlatformPrincipal } from './platform-auth.guard';

/** Changement de mot de passe d'un utilisateur plateforme : mot de passe actuel exigé, autres sessions révoquées, audit. */
@Injectable()
export class PlatformPasswordService {
  constructor(
    private readonly platformDb: PlatformDb,
    private readonly passwords: PasswordService,
    private readonly audit: PlatformAuditService,
    private readonly clock: Clock,
  ) {}

  async change(principal: PlatformPrincipal, input: PlatformPasswordChangeInput): Promise<{ changed: true; revokedSessions: number }> {
    if (!principal.mfa) throw DomainError.forbidden('mfa_enrollment_required', 'La vérification du second facteur est obligatoire.');
    if (input.newPassword === input.currentPassword) {
      throw DomainError.unprocessable('password_unchanged', 'Le nouveau mot de passe doit différer de l’ancien.');
    }
    const user = await this.platformDb.run((tx) => tx.platformUser.findUniqueOrThrow({ where: { id: principal.userId } }));
    if (!(await this.passwords.verify(user.passwordHash, input.currentPassword))) {
      await this.platformDb.run((tx) =>
        this.audit.record(tx, {
          action: 'platform.auth.password_change_failed',
          actor: { type: 'platform_user', userId: user.id, role: user.role },
          outcome: 'failure',
        }),
      );
      throw DomainError.forbidden('invalid_current_password', 'Mot de passe actuel incorrect.');
    }
    const passwordHash = await this.passwords.hash(input.newPassword);
    const now = this.clock.now();
    return this.platformDb.run(async (tx) => {
      await tx.platformUser.update({ where: { id: user.id }, data: { passwordHash, failedAttempts: 0, lockedUntil: null } });
      const revoked = await tx.platformSession.updateMany({
        where: { userId: user.id, revokedAt: null, id: { not: principal.sessionId } },
        data: { revokedAt: now, revokedReason: 'password_changed' },
      });
      await this.audit.record(tx, {
        action: 'platform.auth.password_changed',
        actor: { type: 'platform_user', userId: user.id, role: user.role },
        resourceType: 'platform_user',
        resourceId: user.id,
        changes: { revokedSessions: revoked.count },
      });
      return { changed: true as const, revokedSessions: revoked.count };
    });
  }
}
