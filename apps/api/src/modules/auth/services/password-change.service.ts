import { Injectable } from '@nestjs/common';
import type { ChangePasswordInput } from '@ghmt/shared';
import { PasswordService } from '../../../common/auth/password.service';
import { AuditService } from '../../../common/audit/audit.service';
import type { Principal } from '../../../common/context/request-context';
import { DomainError } from '../../../common/errors/domain-error';
import { Clock } from '../../../common/time/clock';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { loadTenantProfile } from '../../../infrastructure/tenancy/tenant-profile';
import { registerFailedAttempt } from './failed-attempts';
import { LoginDelayEventsService } from './login-delay-events.service';
import { LoginDelayService } from './login-delay.service';
import { invalidatePasswordResetTokens } from './password-reset-tokens';

type Outcome = { kind: 'changed' } | { kind: 'wrong_current' } | { kind: 'unchanged' };

interface Account {
  readonly tenantSlug: string;
  readonly email: string;
  readonly fullName: string;
  readonly passwordHash: string;
}

/**
 * Changement de mot de passe de l'utilisateur connecté (C7) : révoque ses autres sessions et ses jetons de réinitialisation.
 * Le mot de passe actuel est soumis au délai progressif de connexion (docs/11 §14.2) : il ne se devine pas à volonté.
 * Le stockage de limitation (Redis) n'est appelé qu'hors transaction : admission avant, rendu et alerte après le commit.
 */
@Injectable()
export class PasswordChangeService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    private readonly delay: LoginDelayService,
    private readonly delayEvents: LoginDelayEventsService,
    private readonly clock: Clock,
  ) {}

  async change(principal: Principal, input: ChangePasswordInput): Promise<void> {
    const newHash = await this.passwords.hash(input.newPassword);
    const account = await this.tenantDb.run((tx) => this.loadAccount(tx, principal));
    const { tenantSlug, email } = account;

    // Contrôle et réservation atomiques AVANT la vérification du mot de passe actuel, hors transaction (Redis).
    const admission = await this.delay.admit(tenantSlug, email, this.clock.now());
    if (!admission.allowed) {
      await this.delayEvents.delayed(tenantSlug, email, admission.retryAfterSeconds, 'password_change');
      throw DomainError.loginDelayed(admission.retryAfterSeconds);
    }

    // Les échecs (compteur, audit) sont validés avant de lever l'erreur.
    const outcome = await this.tenantDb.run<Outcome>((tx) => this.attempt(tx, principal, input, newHash));
    if (outcome.kind === 'wrong_current') {
      await this.delayEvents.failureCounted({ tenantId: principal.tenantId, tenantSlug, userId: principal.userId, email, fullName: account.fullName, count: admission.count });
      throw DomainError.unprocessable('invalid_current_password', 'Le mot de passe actuel est incorrect.');
    }
    // Mot de passe actuel juste : la tentative réservée n'était pas un échec (rendue après le commit).
    await this.delay.release(tenantSlug, email);
    if (outcome.kind === 'unchanged') throw DomainError.unprocessable('password_unchanged', 'Le nouveau mot de passe doit différer de l’actuel.');
  }

  /** Vérification du mot de passe actuel (relu sous transaction) puis application. */
  private async attempt(tx: TenantTx, principal: Principal, input: ChangePasswordInput, newHash: string): Promise<Outcome> {
    const { passwordHash } = await this.loadAccount(tx, principal);
    if (!(await this.passwords.verify(passwordHash, input.currentPassword))) {
      await this.recordWrongCurrent(tx, principal);
      return { kind: 'wrong_current' };
    }
    if (input.newPassword === input.currentPassword) return { kind: 'unchanged' };
    await this.apply(tx, principal, newHash);
    return { kind: 'changed' };
  }

  private async loadAccount(tx: TenantTx, principal: Principal): Promise<Account> {
    const { tenantId, userId } = principal;
    const user = await tx.user.findUnique({
      where: { tenantId_id: { tenantId, id: userId } },
      select: { email: true, fullName: true, credential: { select: { passwordHash: true } } },
    });
    if (!user?.credential) throw DomainError.unauthorized();
    const profile = await loadTenantProfile(tx);
    return { tenantSlug: profile.slug, email: user.email, fullName: user.fullName, passwordHash: user.credential.passwordHash };
  }

  private async recordWrongCurrent(tx: TenantTx, principal: Principal): Promise<void> {
    const { tenantId, userId } = principal;
    await registerFailedAttempt(tx, tenantId, userId);
    await this.audit.record(tx, tenantId, { action: 'auth.password.change_failed', outcome: 'failure', resourceType: 'user', resourceId: userId });
  }

  private async apply(tx: TenantTx, principal: Principal, newHash: string): Promise<void> {
    const { tenantId, userId, sessionId } = principal;
    const now = this.clock.now();
    await tx.userCredential.update({
      where: { tenantId_userId: { tenantId, userId } },
      data: { passwordHash: newHash, passwordChangedAt: now, mustChangePassword: false, failedAttempts: 0 },
    });
    const revoked = await tx.session.updateMany({
      where: { userId, revokedAt: null, id: { not: sessionId } },
      data: { revokedAt: now, revokedReason: 'password_changed' },
    });
    const invalidatedResetTokens = await invalidatePasswordResetTokens(tx, tenantId, userId, now);
    await this.audit.record(tx, tenantId, {
      action: 'auth.password.changed',
      resourceType: 'user',
      resourceId: userId,
      changes: { revokedSessions: revoked.count, invalidatedResetTokens },
    });
  }
}
