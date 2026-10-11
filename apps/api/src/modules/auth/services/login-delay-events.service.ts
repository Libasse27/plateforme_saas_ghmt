import { Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../../../common/audit/audit.service';
import { MAILER, type Mailer } from '../../../common/mail/mailer';
import { buildSuspiciousLoginEmail } from '../../../common/mail/security-emails';
import { BackgroundTasks } from '../../../common/tasks/background-tasks';
import { Clock } from '../../../common/time/clock';
import { ENV, type Env } from '../../../infrastructure/config/env';
import { TenantDb } from '../../../infrastructure/prisma/tenant-db.service';
import { loadTenantProfile } from '../../../infrastructure/tenancy/tenant-profile';
import { SecurityAlertService } from '../../notifications/services/security-alert.service';
import { SUSPICIOUS_LOGIN_THRESHOLD } from '../auth.constants';
import { LoginDelayService } from './login-delay.service';

/** Étape à l'origine d'un refus ou d'un échec compté dans le délai progressif. */
export type DelaySource = 'login' | 'mfa' | 'password_change' | 'password_reset';

/** Compte existant et actif dont un échec vient d'être compté. */
export interface FailedAccount {
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly userId: string;
  readonly email: string;
  readonly fullName: string;
  /** Échecs consécutifs comptés, celui-ci compris. */
  readonly count: number;
}

/**
 * Événements du délai progressif (docs/11 D3, décision 21) : audit des refus `login_delayed` et, au 10e échec consécutif,
 * e-mail « tentatives inhabituelles » à l'utilisateur et alerte aux administrateurs. Tout s'exécute hors requête : ni la
 * réponse ni son temps ne dépendent de l'existence du compte.
 */
@Injectable()
export class LoginDelayEventsService {
  private readonly logger = new Logger(LoginDelayEventsService.name);

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly delay: LoginDelayService,
    private readonly alerts: SecurityAlertService,
    private readonly background: BackgroundTasks,
    private readonly clock: Clock,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Refus `login_delayed` : audit `auth.login.delayed` d'un compte existant, au plus un par identifiant et par heure. */
  async delayed(tenantSlug: string, email: string, retryAfterSeconds: number, source: DelaySource): Promise<void> {
    if (!(await this.delay.claimDelayedAudit(tenantSlug, email, this.clock.now()))) return;
    this.background.run('audit de connexion ralentie', () => this.auditDelayed(tenantSlug, email, retryAfterSeconds, source));
  }

  /** Au seuil, une fois par compte et par 24 h : e-mail à l'utilisateur et alerte `security.login_delay_alert` aux administrateurs. */
  async failureCounted(account: FailedAccount): Promise<void> {
    if (account.count < SUSPICIOUS_LOGIN_THRESHOLD) return;
    if (!(await this.delay.claimSuspiciousAlert(account.tenantId, account.userId))) return;
    this.background.run('alerte de connexion', () => this.notify(account));
  }

  private async auditDelayed(tenantSlug: string, email: string, retryAfterSeconds: number, source: DelaySource): Promise<void> {
    const rows = await this.tenantDb.runWithoutTenant((tx) => tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM platform.resolve_tenant(${tenantSlug})`);
    const tenantId = rows[0]?.id;
    if (!tenantId) return;
    await this.tenantDb.runAs(tenantId, async (tx) => {
      const user = await tx.user.findUnique({ where: { tenantId_email: { tenantId, email } }, select: { id: true } });
      if (!user) return;
      await this.audit.record(tx, tenantId, {
        action: 'auth.login.delayed',
        outcome: 'denied',
        actorType: 'user',
        actorUserId: user.id,
        resourceType: 'user',
        resourceId: user.id,
        changes: { retryAfterSeconds, source },
      });
    });
  }

  private async notify(account: FailedAccount): Promise<void> {
    const { tenantId, userId } = account;
    const tenantName = await this.tenantDb.runAs(tenantId, async (tx) => {
      const notified = await this.alerts.establishmentAlert(tx, tenantId, 'security.login_delay_alert', { audience: 'administrators', targetUserId: userId }, this.clock.now());
      await this.audit.record(tx, tenantId, {
        action: 'auth.login.suspicious_activity_notified',
        actorType: 'system',
        resourceType: 'user',
        resourceId: userId,
        changes: { notifiedAdministrators: notified },
      });
      return (await loadTenantProfile(tx)).name;
    });
    try {
      await this.mailer.send(buildSuspiciousLoginEmail({ to: account.email, fullName: account.fullName, tenantName, tenantSlug: account.tenantSlug, webUrl: this.env.WEB_URL }));
    } catch (error: unknown) {
      // Ni l'adresse ni le message d'erreur (susceptible de citer le contenu) ne sont journalisés.
      this.logger.warn(`Envoi de l’alerte de connexion en échec (${error instanceof Error ? error.name : 'inconnue'}).`);
    }
  }
}
