import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PlatformAuditService } from '../../common/audit/platform-audit.service';
import { Clock } from '../../common/time/clock';
import { ENV, type Env } from '../../infrastructure/config/env';
import { PlatformDb, type PlatformTx } from '../../infrastructure/prisma/platform-db.service';
import { TenantDb } from '../../infrastructure/prisma/tenant-db.service';
import {
  EXPIRED_FOUNDER_ANONYMIZE_AFTER_MS,
  PENDING_SIGNUP_EXPIRY_MS,
  SIGNUP_VERIFICATION_PURGE_AFTER_MS,
  SIGNUP_VERIFICATION_PURGE_BATCH,
  STARTUP_PASS_DELAY_MS,
} from './onboarding.constants';

export interface SignupExpiryReport {
  readonly expired: number;
  readonly purged: number;
  readonly anonymized: number;
  readonly errors: number;
}

const ANONYMIZED_NAME = 'Utilisateur supprimé';
const ANONYMIZED_EMAIL_SUFFIX = '@anonymise.invalid';

interface KnownTenant {
  readonly id: string;
  readonly slug: string;
  readonly status: string;
  readonly deletedAt: Date | null;
}

/** Inscription expirée par ce job : `terminated` et identifiant renommé `expired-<id>`. */
function isExpiredSignup(tenant: KnownTenant): boolean {
  return tenant.status === 'terminated' && tenant.slug.startsWith('expired-');
}

interface RunOptions {
  /** Restreint l'exécution à ces établissements (tests). */
  readonly tenantIds?: readonly string[];
}

/**
 * Expiration des inscriptions non confirmées (docs/11 §6.3), chaque jour à 04:00 UTC et 60 s après le démarrage :
 * un tenant `pending` créé il y a plus de 7 jours passe `terminated`, reçoit `deleted_at` et son identifiant est
 * libéré (`expired-<id>`) et son abonnement d'essai annulé. Purge les jetons de vérification (expirés depuis plus d'un
 * jour, et tous ceux d'un tenant expiré) et, 30 jours après l'expiration, anonymise l'administrateur fondateur
 * (docs/11 §14.3.3).
 */
@Injectable()
export class PendingSignupExpiryJob implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(PendingSignupExpiryJob.name);
  private startupTimer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly platformDb: PlatformDb,
    private readonly tenantDb: TenantDb,
    private readonly platformAudit: PlatformAuditService,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.env.SECURITY_JOBS_ENABLED) return;
    this.startupTimer = setTimeout(() => void this.scheduledRun(), STARTUP_PASS_DELAY_MS);
    this.startupTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.startupTimer) clearTimeout(this.startupTimer);
  }

  @Cron('0 4 * * *', { timeZone: 'UTC' })
  async scheduledRun(): Promise<void> {
    if (!this.env.SECURITY_JOBS_ENABLED || this.running) return;
    this.running = true;
    try {
      this.logger.log({ ...(await this.runOnce(this.clock.now())) }, 'Expiration des inscriptions non confirmées');
    } catch (error: unknown) {
      this.logger.error({ errorClass: error instanceof Error ? error.name : 'unknown' }, 'Échec de l’expiration des inscriptions');
    } finally {
      this.running = false;
    }
  }

  /** Une passe, à la date donnée (testable avec une horloge simulée). */
  async runOnce(now: Date, options: RunOptions = {}): Promise<SignupExpiryReport> {
    const expiry = await this.expirePendingTenants(now, options);
    const purge = await this.purgeVerifications(now, options);
    const anonymization = await this.anonymizeExpiredFounders(now, options);
    return {
      expired: expiry.expired,
      purged: purge.purged,
      anonymized: anonymization.anonymized,
      errors: expiry.errors + purge.errors + anonymization.errors,
    };
  }

  private async expirePendingTenants(now: Date, options: RunOptions): Promise<{ expired: number; errors: number }> {
    const cutoff = new Date(now.getTime() - PENDING_SIGNUP_EXPIRY_MS);
    const candidates = await this.platformDb.run((tx) =>
      tx.tenant.findMany({
        where: { status: 'pending', deletedAt: null, createdAt: { lt: cutoff }, ...(options.tenantIds ? { id: { in: [...options.tenantIds] } } : {}) },
        select: { id: true },
        orderBy: { id: 'asc' },
      }),
    );
    let expired = 0;
    let errors = 0;
    for (const { id } of candidates) {
      try {
        if (await this.expireOne(id, now)) expired += 1;
      } catch (error: unknown) {
        errors += 1;
        this.logger.error({ tenantId: id, errorClass: error instanceof Error ? error.name : 'unknown' }, 'Expiration impossible pour une inscription');
      }
    }
    return { expired, errors };
  }

  /** Conditionnelle (`pending` et non supprimé) : un tenant confirmé entre-temps n'est jamais touché. */
  private expireOne(id: string, now: Date): Promise<boolean> {
    return this.platformDb.run(async (tx) => {
      const current = await tx.tenant.findFirst({ where: { id, status: 'pending', deletedAt: null }, select: { slug: true } });
      if (!current) return false;
      const updated = await tx.tenant.updateMany({
        where: { id, status: 'pending', deletedAt: null },
        data: { status: 'terminated', deletedAt: now, slug: `expired-${id}`, updatedAt: now },
      });
      if (updated.count === 0) return false;
      await this.platformAudit.record(tx, {
        action: 'tenant.signup_expired',
        actor: { type: 'system' },
        resourceType: 'tenant',
        resourceId: id,
        tenantId: id,
        changes: { tenantId: id, previousSlug: current.slug },
      });
      await this.cancelTrial(tx, id, now);
      return true;
    });
  }

  /** Abonnement d'essai annulé avec le tenant : aucune relance SaaS ni facture pour un établissement jamais confirmé. */
  private async cancelTrial(tx: PlatformTx, tenantId: string, now: Date): Promise<void> {
    const subscription = await tx.subscription.findUnique({ where: { tenantId }, select: { id: true, status: true } });
    if (!subscription || subscription.status === 'cancelled' || subscription.status === 'expired') return;
    await tx.subscription.update({ where: { tenantId }, data: { status: 'cancelled', statusChangedAt: now } });
    await this.platformAudit.record(tx, {
      action: 'subscription.status_changed',
      actor: { type: 'system' },
      resourceType: 'subscription',
      resourceId: subscription.id,
      tenantId,
      changes: { from: subscription.status, to: 'cancelled', reason: 'signup_expired' },
    });
  }

  private async purgeVerifications(now: Date, options: RunOptions): Promise<{ purged: number; errors: number }> {
    const tenants = await this.knownTenants(options);
    const olderThan = new Date(now.getTime() - SIGNUP_VERIFICATION_PURGE_AFTER_MS);
    let purged = 0;
    let errors = 0;
    for (const tenant of tenants) {
      try {
        // Un tenant expiré ne doit conserver aucun jeton : tout est supprimé, échu ou non.
        purged += await this.purgeTenant(tenant.id, isExpiredSignup(tenant) ? undefined : olderThan);
      } catch (error: unknown) {
        errors += 1;
        this.logger.error({ tenantId: tenant.id, errorClass: error instanceof Error ? error.name : 'unknown' }, 'Purge des vérifications impossible');
      }
    }
    return { purged, errors };
  }

  /** Par lots plafonnés : `(tenant_id, id) IN (SELECT … LIMIT n)`. `olderThan` absent : tous les jetons du tenant. */
  private purgeTenant(tenantId: string, olderThan: Date | undefined): Promise<number> {
    const cutoff = olderThan ?? new Date(8_640_000_000_000_000); // « toute échéance » : aucune borne
    return this.tenantDb.runAs(
      tenantId,
      (tx) => tx.$executeRaw`
        DELETE FROM tenant.signup_verifications
        WHERE (tenant_id, id) IN (
          SELECT tenant_id, id FROM tenant.signup_verifications
          WHERE tenant_id = ${tenantId}::uuid AND expires_at < ${cutoff}::timestamptz
          LIMIT ${SIGNUP_VERIFICATION_PURGE_BATCH})`,
    );
  }

  /** Anonymisation du fondateur 30 jours après l'expiration : jamais avant, jamais deux fois (docs/11 §14.3.3). */
  private async anonymizeExpiredFounders(now: Date, options: RunOptions): Promise<{ anonymized: number; errors: number }> {
    const dueBefore = new Date(now.getTime() - EXPIRED_FOUNDER_ANONYMIZE_AFTER_MS);
    const tenants = (await this.knownTenants(options)).filter((t) => isExpiredSignup(t) && t.deletedAt !== null && t.deletedAt <= dueBefore);
    let anonymized = 0;
    let errors = 0;
    for (const tenant of tenants) {
      try {
        const count = await this.anonymizeTenant(tenant.id);
        if (count > 0) {
          await this.platformDb.run((tx) =>
            this.platformAudit.record(tx, {
              action: 'tenant.signup_anonymized',
              actor: { type: 'system' },
              resourceType: 'tenant',
              resourceId: tenant.id,
              tenantId: tenant.id,
              changes: { tenantId: tenant.id, anonymizedUsers: count },
            }),
          );
          anonymized += 1;
        }
      } catch (error: unknown) {
        errors += 1;
        this.logger.error({ tenantId: tenant.id, errorClass: error instanceof Error ? error.name : 'unknown' }, 'Anonymisation impossible pour une inscription expirée');
      }
    }
    return { anonymized, errors };
  }

  /** Remplace nom et e-mail, supprime mot de passe, sessions (jetons en cascade) et facteurs. Renvoie le nombre d'utilisateurs traités. */
  private anonymizeTenant(tenantId: string): Promise<number> {
    return this.tenantDb.runAs(tenantId, async (tx) => {
      const users = await tx.user.findMany({ where: { tenantId, NOT: { email: { endsWith: ANONYMIZED_EMAIL_SUFFIX } } }, select: { id: true } });
      for (const { id } of users) {
        await tx.userCredential.deleteMany({ where: { tenantId, userId: id } });
        await tx.session.deleteMany({ where: { tenantId, userId: id } });
        await tx.mfaFactor.deleteMany({ where: { tenantId, userId: id } });
        await tx.user.update({
          where: { tenantId_id: { tenantId, id } },
          data: { fullName: ANONYMIZED_NAME, email: `supprime-${id}${ANONYMIZED_EMAIL_SUFFIX}`, status: 'disabled', rowVersion: { increment: 1 } },
          select: { id: true },
        });
      }
      return users.length;
    });
  }

  /** Tenants concernés : ceux de `tenantIds` (tests) ou tous (les tenants expirés sont supprimés logiquement, donc inclus). */
  private knownTenants(options: RunOptions): Promise<KnownTenant[]> {
    return this.platformDb.run((tx) =>
      tx.tenant.findMany({
        where: options.tenantIds ? { id: { in: [...options.tenantIds] } } : {},
        select: { id: true, slug: true, status: true, deletedAt: true },
        orderBy: { id: 'asc' },
      }),
    );
  }
}
