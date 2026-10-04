import { Injectable } from '@nestjs/common';
import type { ChangePasswordInput } from '@ghmt/shared';
import { PasswordService } from '../../../common/auth/password.service';
import { AuditService } from '../../../common/audit/audit.service';
import type { Principal } from '../../../common/context/request-context';
import { DomainError } from '../../../common/errors/domain-error';
import { TenantDb } from '../../../infrastructure/prisma/tenant-db.service';
import { registerFailedAttempt } from './lockout';

type Outcome = 'changed' | 'wrong_current' | 'unchanged';

/** Changement de mot de passe de l'utilisateur connecté (C7) : révoque ses autres sessions. */
@Injectable()
export class PasswordChangeService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
  ) {}

  async change(principal: Principal, input: ChangePasswordInput): Promise<void> {
    const { tenantId, userId, sessionId } = principal;
    const newHash = await this.passwords.hash(input.newPassword);

    // Les échecs (compteur, audit) sont validés avant de lever l'erreur : le mot de passe actuel ne se devine pas à volonté.
    const outcome = await this.tenantDb.run<Outcome>(async (tx) => {
      const where = { tenantId_userId: { tenantId, userId } };
      const credential = await tx.userCredential.findUnique({ where, select: { passwordHash: true } });
      if (!credential) throw DomainError.unauthorized();

      if (!(await this.passwords.verify(credential.passwordHash, input.currentPassword))) {
        await registerFailedAttempt(tx, tenantId, userId, new Date());
        await this.audit.record(tx, tenantId, { action: 'auth.password.change_failed', outcome: 'failure', resourceType: 'user', resourceId: userId });
        return 'wrong_current';
      }
      if (input.newPassword === input.currentPassword) return 'unchanged';

      const now = new Date();
      await tx.userCredential.update({
        where,
        data: { passwordHash: newHash, passwordChangedAt: now, mustChangePassword: false, failedAttempts: 0, lockedUntil: null },
      });
      const revoked = await tx.session.updateMany({
        where: { userId, revokedAt: null, id: { not: sessionId } },
        data: { revokedAt: now, revokedReason: 'password_changed' },
      });
      await this.audit.record(tx, tenantId, {
        action: 'auth.password.changed',
        resourceType: 'user',
        resourceId: userId,
        changes: { revokedSessions: revoked.count },
      });
      return 'changed';
    });

    if (outcome === 'wrong_current') throw DomainError.unprocessable('invalid_current_password', 'Le mot de passe actuel est incorrect.');
    if (outcome === 'unchanged') throw DomainError.unprocessable('password_unchanged', 'Le nouveau mot de passe doit différer de l’actuel.');
  }
}
