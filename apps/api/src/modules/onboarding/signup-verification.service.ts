import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ResendSignupVerificationInput, SignupVerificationResult } from '@ghmt/shared';
import { parseOpaqueToken } from '../../common/auth/opaque-token';
import { AuditService } from '../../common/audit/audit.service';
import { DomainError } from '../../common/errors/domain-error';
import { MAILER, type Mailer } from '../../common/mail/mailer';
import { RATE_LIMIT_STORE } from '../../common/rate-limit/rate-limit-runtime';
import type { RateLimitStore } from '../../common/rate-limit/rate-limit-store';
import { BackgroundTasks } from '../../common/tasks/background-tasks';
import { Clock } from '../../common/time/clock';
import { ENV, type Env } from '../../infrastructure/config/env';
import { TenantDb } from '../../infrastructure/prisma/tenant-db.service';
import { loadTenantProfile } from '../../infrastructure/tenancy/tenant-profile';
import { PENDING_SIGNUP_EXPIRY_MS } from './onboarding.constants';
import { createSignupVerification, deliverSignupVerification, invalidateOpenSignupVerifications } from './signup-verification';

/** Même réponse pour un jeton inconnu, mal formé, expiré, consommé ou d'un tenant qui n'est plus en attente : aucun oracle. */
function invalidToken(): DomainError {
  return DomainError.gone('verification_token_invalid', 'Ce lien de confirmation est invalide, déjà utilisé ou expiré.');
}

/** Vérification de l'adresse e-mail de l'administrateur fondateur et renvoi du lien (docs/11 D12, §6.2). */
@Injectable()
export class SignupVerificationService {
  private readonly logger = new Logger(SignupVerificationService.name);

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly background: BackgroundTasks,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(ENV) private readonly env: Env,
    @Inject(RATE_LIMIT_STORE) private readonly store: RateLimitStore,
  ) {}

  /**
   * Consomme le jeton, renseigne `email_verified_at` et active le tenant (`platform.activate_pending_tenant`).
   * Tout ou rien : si le tenant n'est plus `pending`, la transaction est annulée et le jeton reste intact.
   * N'ouvre aucune session.
   */
  async verify(rawToken: string): Promise<SignupVerificationResult> {
    const parsed = parseOpaqueToken(rawToken);
    if (!parsed) throw invalidToken();
    const { tenantId, hash } = parsed;
    const now = this.clock.now();

    return this.tenantDb.runAs(tenantId, async (tx) => {
      const verification = await tx.signupVerification.findUnique({
        where: { tenantId_tokenHash: { tenantId, tokenHash: hash } },
        select: { userId: true, consumedAt: true, expiresAt: true },
      });
      if (!verification || verification.consumedAt || verification.expiresAt <= now) throw invalidToken();

      // Consommation atomique : deux confirmations concurrentes ne peuvent pas toutes deux réussir.
      const claimed = await tx.signupVerification.updateMany({
        where: { tenantId, tokenHash: hash, consumedAt: null, expiresAt: { gt: now } },
        data: { consumedAt: now },
      });
      if (claimed.count === 0) throw invalidToken();

      const [activation] = await tx.$queryRaw<{ activated: boolean }[]>`SELECT platform.activate_pending_tenant() AS activated`;
      if (!activation?.activated) throw invalidToken();

      await tx.user.updateMany({
        where: { tenantId, id: verification.userId, emailVerifiedAt: null },
        data: { emailVerifiedAt: now },
      });
      await this.audit.record(tx, tenantId, {
        action: 'tenant.signup_verified',
        actorType: 'user',
        actorUserId: verification.userId,
        resourceType: 'tenant',
        resourceId: tenantId,
      });
      const profile = await loadTenantProfile(tx);
      return { tenantSlug: profile.slug };
    });
  }

  /**
   * Renvoi du lien : la réponse HTTP (202) est identique quel que soit le compte ; la recherche, le nouveau jeton et
   * l'e-mail s'exécutent après la réponse. Les jetons précédents sont invalidés.
   */
  requestResend(input: ResendSignupVerificationInput): void {
    this.background.run('signup_resend', () => this.processResend(input));
  }

  private async processResend(input: ResendSignupVerificationInput): Promise<void> {
    const tenantId = await this.findPendingTenant(input.tenantSlug);
    if (!tenantId) return;
    const prepared = await this.prepareResend(tenantId, input.email);
    if (!prepared) return;
    await deliverSignupVerification(
      { mailer: this.mailer, tenantDb: this.tenantDb, audit: this.audit, store: this.store, webUrl: this.env.WEB_URL, logger: this.logger },
      { tenantId, ...prepared, email: input.email, tenantSlug: input.tenantSlug, resend: true },
    );
  }

  private async findPendingTenant(slug: string): Promise<string | undefined> {
    const rows = await this.tenantDb.runWithoutTenant(
      (tx) => tx.$queryRaw<{ id: string; status: string }[]>`SELECT id::text AS id, status::text AS status FROM platform.resolve_tenant(${slug})`,
    );
    const tenant = rows[0];
    return tenant?.status === 'pending' ? tenant.id : undefined;
  }

  /** Administrateur fondateur non vérifié, dans le délai d'expiration : nouveau jeton (les précédents sont invalidés). */
  private prepareResend(
    tenantId: string,
    email: string,
  ): Promise<{ userId: string; token: string } | undefined> {
    const now = this.clock.now();
    const oldestAllowed = new Date(now.getTime() - PENDING_SIGNUP_EXPIRY_MS);
    return this.tenantDb.runAs(tenantId, async (tx) => {
      const founder = await tx.user.findFirst({
        where: { tenantId, email, status: 'active', emailVerifiedAt: null, deletedAt: null, createdAt: { gt: oldestAllowed } },
        select: { id: true },
      });
      if (!founder) return undefined;
      await invalidateOpenSignupVerifications(tx, { tenantId, userId: founder.id, now });
      const token = await createSignupVerification(tx, { tenantId, userId: founder.id, now });
      return { userId: founder.id, token };
    });
  }
}
