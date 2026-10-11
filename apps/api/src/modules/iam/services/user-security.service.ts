import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../../common/audit/audit.service';
import { RequestContext } from '../../../common/context/request-context';
import { DomainError } from '../../../common/errors/domain-error';
import { MAILER, type Mailer } from '../../../common/mail/mailer';
import { buildMfaResetEmail } from '../../../common/mail/security-emails';
import { ENV, type Env } from '../../../infrastructure/config/env';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { loadTenantProfile } from '../../../infrastructure/tenancy/tenant-profile';
import { TOTP_KIND } from '../../auth/auth.constants';
import { LoginDelayService } from '../../auth/services/login-delay.service';
import { SecurityAlertService } from '../../notifications/services/security-alert.service';
import { invalidatePasswordResetTokens } from '../../auth/services/password-reset-tokens';
import { revokeAllSessions } from './account-security';
import { HierarchyService } from './hierarchy.service';
import { UserViewsService } from './user-views.service';

/** Identifiant du compteur de délai progressif d'un compte (docs/11 D3). */
export interface LoginDelayKey {
  readonly tenantSlug: string;
  readonly email: string;
}

/**
 * Opérations de secours sur un compte (docs/11 §5.6, §14.1) : déverrouillage et réinitialisation du second facteur, avec un
 * motif obligatoire repris dans l'audit (vérification d'identité faite hors application).
 */
@Injectable()
export class UserSecurityService {
  private readonly logger = new Logger(UserSecurityService.name);

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly context: RequestContext,
    private readonly hierarchy: HierarchyService,
    private readonly views: UserViewsService,
    private readonly delay: LoginDelayService,
    private readonly alerts: SecurityAlertService,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Remet à zéro le délai progressif de connexion (échecs consécutifs) d'un utilisateur. */
  async unlock(id: string, reason: string) {
    const principal = this.context.requirePrincipal();
    const { delayKey } = await this.tenantDb.run(async (tx) => {
      await this.requireUser(tx, id);
      await this.hierarchy.assertCanManageUser(tx, id);
      const reset = await tx.userCredential.updateMany({ where: { userId: id }, data: { failedAttempts: 0 } });
      await this.audit.record(tx, principal.tenantId, {
        action: 'iam.user.unlocked',
        resourceType: 'user',
        resourceId: id,
        changes: { credentialReset: reset.count > 0, reason },
      });
      return { delayKey: await this.loginDelayKey(tx, id) };
    });
    // Effet hors base APRÈS le commit : une transaction annulée ne lève pas le délai.
    await this.clearLoginDelay(delayKey);
    return this.tenantDb.run((tx) => this.views.detail(tx, id));
  }

  /** Réinitialisation du second facteur par un administrateur : facteur supprimé, sessions coupées, e-mail, alerte aux directeurs. */
  async resetMfa(id: string, reason: string): Promise<void> {
    const principal = this.context.requirePrincipal();
    if (principal.userId === id) throw DomainError.unprocessable('self_mfa_reset', 'Vous ne pouvez pas réinitialiser votre propre second facteur.');
    const notice = await this.tenantDb.run(async (tx) => {
      await this.requireUser(tx, id);
      await this.hierarchy.assertCanManageUser(tx, id);
      const removed = await tx.mfaFactor.deleteMany({ where: { userId: id, kind: TOTP_KIND } });
      if (removed.count === 0) throw DomainError.conflict('mfa_not_enrolled', 'Aucun second facteur n’est enregistré pour cet utilisateur.');
      const revoked = await revokeAllSessions(tx, id, 'mfa_reset');
      // Un lien de réinitialisation du mot de passe déjà émis ne doit pas survivre à la perte du second facteur.
      const resetTokens = await invalidatePasswordResetTokens(tx, principal.tenantId, id, new Date());
      await this.audit.record(tx, principal.tenantId, {
        action: 'iam.user.mfa_reset',
        resourceType: 'user',
        resourceId: id,
        changes: { revokedSessions: revoked, invalidatedResetTokens: resetTokens, reason },
      });
      await this.alerts.establishmentAlert(tx, principal.tenantId, 'security.mfa_reset', { audience: 'directors_and_owner', actorUserId: principal.userId, targetUserId: id }, new Date());
      const [target, actor, profile] = await Promise.all([
        tx.user.findFirstOrThrow({ where: { id }, select: { email: true, fullName: true } }),
        tx.user.findFirstOrThrow({ where: { id: principal.userId }, select: { fullName: true } }),
        loadTenantProfile(tx),
      ]);
      return { to: target.email, fullName: target.fullName, actorName: actor.fullName, tenantName: profile.name, tenantSlug: profile.slug };
    });
    try {
      await this.mailer.send(buildMfaResetEmail({ ...notice, webUrl: this.env.WEB_URL }));
    } catch (error: unknown) {
      this.logger.warn(`Envoi de l’e-mail de réinitialisation du second facteur en échec (${error instanceof Error ? error.name : 'inconnue'}).`);
    }
  }

  /** Identifiant du compteur de délai progressif (code établissement et e-mail), lu dans la transaction ; `null` si inconnu. */
  async loginDelayKey(tx: TenantTx, userId: string): Promise<LoginDelayKey | null> {
    const [user, profile] = await Promise.all([tx.user.findFirst({ where: { id: userId }, select: { email: true } }), loadTenantProfile(tx)]);
    return user ? { tenantSlug: profile.slug, email: user.email } : null;
  }

  /** Efface le compteur de délai progressif : à appeler après le commit de la transaction qui l'a décidé. */
  async clearLoginDelay(key: LoginDelayKey | null): Promise<void> {
    if (key) await this.delay.clear(key.tenantSlug, key.email);
  }

  private async requireUser(tx: TenantTx, id: string): Promise<void> {
    const user = await tx.user.findFirst({ where: { id, deletedAt: null }, select: { id: true } });
    if (!user) throw DomainError.notFound('Utilisateur');
  }
}
