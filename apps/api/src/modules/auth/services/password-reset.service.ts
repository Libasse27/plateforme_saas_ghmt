import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ForgotPasswordInput, PasswordResetPreview, ResetPasswordInput } from '@ghmt/shared';
import { AuditService } from '../../../common/audit/audit.service';
import { issueOpaqueToken, parseOpaqueToken } from '../../../common/auth/opaque-token';
import { PasswordService } from '../../../common/auth/password.service';
import { AuthorizationService } from '../../../common/authz/authorization.service';
import { DomainError } from '../../../common/errors/domain-error';
import { MAILER, type Mailer } from '../../../common/mail/mailer';
import { buildPasswordResetEmail } from '../../../common/mail/password-reset-email';
import { buildPasswordChangedEmail } from '../../../common/mail/security-emails';
import { BackgroundTasks } from '../../../common/tasks/background-tasks';
import { Clock } from '../../../common/time/clock';
import { ENV, type Env } from '../../../infrastructure/config/env';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { loadTenantProfile } from '../../../infrastructure/tenancy/tenant-profile';
import { maskEmail } from '../../notifications/domain/masking';
import { PASSWORD_RESET_MAX_MFA_ATTEMPTS, PASSWORD_RESET_REISSUE_AFTER_MS, PASSWORD_RESET_TTL_MS, SESSION_TENANT_STATUSES, TOTP_KIND } from '../auth.constants';
import { LoginDelayEventsService } from './login-delay-events.service';
import { LoginContextService } from './login-context.service';
import { LoginDelayService, type LoginAdmission } from './login-delay.service';
import { MfaCodeChecker, type FactorSnapshot } from './mfa-code-checker.service';
import { invalidatePasswordResetTokens } from './password-reset-tokens';
import { SessionService } from './session.service';

const TTL_MINUTES = PASSWORD_RESET_TTL_MS / 60_000;

function invalidToken(): DomainError {
  return DomainError.gone('reset_token_invalid', 'Ce lien de réinitialisation est invalide ou expiré.');
}

type ResetOutcome =
  | { kind: 'done'; email: string; fullName: string; tenantName: string; tenantSlug: string }
  | { kind: 'invalid_token' }
  | { kind: 'mfa_required' }
  | { kind: 'wrong_code'; userId: string; fullName: string };

/** Lecture préalable du jeton : identifiant du délai progressif (`slug|email`) quand un code sera vérifié. */
type ResetPreflight = { kind: 'invalid_token' } | { kind: 'mfa_required' } | { kind: 'ready'; delayIdentity: DelayIdentity | null };

interface DelayIdentity {
  readonly tenantSlug: string;
  readonly email: string;
}

interface LoadedReset {
  readonly tokenId: string;
  readonly userId: string;
  readonly email: string;
  readonly fullName: string;
  readonly factor: FactorSnapshot | null;
}

/** Mot de passe oublié et réinitialisation (docs/11 D8, §5.1). Le jeton n'est jamais journalisé. */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    private readonly tenantDb: TenantDb,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    private readonly authz: AuthorizationService,
    private readonly codes: MfaCodeChecker,
    private readonly sessions: SessionService,
    private readonly delay: LoginDelayService,
    private readonly contexts: LoginContextService,
    private readonly delayEvents: LoginDelayEventsService,
    private readonly background: BackgroundTasks,
    private readonly clock: Clock,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Répond toujours pareil : tout le travail (résolution, jeton, e-mail) a lieu après la réponse. */
  requestReset(input: ForgotPasswordInput): { accepted: true } {
    this.background.run('mot de passe oublié', () => this.process(input));
    return { accepted: true };
  }

  async preview(token: string): Promise<PasswordResetPreview> {
    const parsed = parseOpaqueToken(token);
    if (!parsed) throw invalidToken();
    const now = this.clock.now();
    const result = await this.tenantDb.runAs(parsed.tenantId, async (tx) => {
      const loaded = await this.loadUsable(tx, parsed.tenantId, parsed.hash, now);
      if (!loaded) return undefined;
      const profile = await loadTenantProfile(tx);
      return { tenantSlug: profile.slug, emailMasked: maskEmail(loaded.email), mfaRequired: loaded.factor !== null };
    });
    if (!result) throw invalidToken();
    return result;
  }

  /**
   * Un code de second facteur faux alimente le délai progressif commun (`slug|email`, comme `mfa/verify`) et le délai est
   * contrôlé avant toute vérification du code. Le stockage de limitation (Redis) n'est appelé qu'hors transaction.
   */
  async reset(input: ResetPasswordInput): Promise<void> {
    const parsed = parseOpaqueToken(input.token);
    if (!parsed) throw invalidToken();
    const { tenantId, hash } = parsed;
    const newHash = await this.passwords.hash(input.newPassword);
    const preflight = await this.tenantDb.runAs(tenantId, (tx) => this.loadPreflight(tx, tenantId, hash, input.mfaCode));
    if (preflight.kind !== 'ready') throw this.preflightError(preflight.kind);
    const identity = preflight.delayIdentity;
    const admission = identity ? await this.admit(tenantId, identity) : undefined;

    // Les essais de second facteur et l'audit sont validés (commit) avant de lever l'erreur.
    const outcome = await this.tenantDb.runAs(tenantId, (tx) => this.attemptReset(tx, tenantId, hash, newHash, input.mfaCode));
    if (outcome.kind === 'done') return this.confirm(outcome, admission);
    if (identity && admission) await this.afterRefusal(tenantId, identity, admission, outcome);
    if (outcome.kind === 'wrong_code') throw DomainError.unprocessable('invalid_code', 'Code de vérification invalide.');
    throw this.preflightError(outcome.kind);
  }

  private preflightError(kind: 'invalid_token' | 'mfa_required'): DomainError {
    if (kind === 'invalid_token') return invalidToken();
    return new DomainError('mfa_code_required', 422, 'Unprocessable Entity', 'Un code de vérification est requis.', {
      errors: [{ path: 'mfaCode', code: 'required', message: 'Code de vérification requis.' }],
    });
  }

  private async loadPreflight(tx: TenantTx, tenantId: string, tokenHash: Uint8Array<ArrayBuffer>, mfaCode: string | undefined): Promise<ResetPreflight> {
    const loaded = await this.loadUsable(tx, tenantId, tokenHash, this.clock.now());
    if (!loaded) return { kind: 'invalid_token' };
    if (!loaded.factor) return { kind: 'ready', delayIdentity: null };
    if (!mfaCode) return { kind: 'mfa_required' };
    return { kind: 'ready', delayIdentity: { tenantSlug: (await loadTenantProfile(tx)).slug, email: loaded.email } };
  }

  /** Contrôle et réservation atomiques avant la vérification du code (contexte connu : décisions 21 et 25). */
  private async admit(tenantId: string, identity: DelayIdentity): Promise<LoginAdmission> {
    const { tenantSlug, email } = identity;
    const now = this.clock.now();
    const admission = await this.delay.admit(tenantSlug, email, now, () => this.contexts.evaluate(tenantId, email, now));
    if (admission.allowed) return admission;
    await this.delayEvents.delayed(tenantSlug, email, admission.retryAfterSeconds, 'password_reset');
    throw DomainError.loginDelayed(admission.retryAfterSeconds);
  }

  /** Après le commit : code faux compté (alerte au seuil) ; jeton devenu invalide entre-temps : réservation rendue. */
  private async afterRefusal(tenantId: string, identity: DelayIdentity, admission: LoginAdmission, outcome: ResetOutcome): Promise<void> {
    if (outcome.kind !== 'wrong_code') {
      await this.delay.release(admission);
      return;
    }
    await this.delayEvents.failureCounted({ tenantId, ...identity, userId: outcome.userId, fullName: outcome.fullName, count: admission.count });
  }

  private async confirm(outcome: Extract<ResetOutcome, { kind: 'done' }>, admission: LoginAdmission | undefined): Promise<void> {
    await this.delay.clear(outcome.tenantSlug, outcome.email, admission);
    this.background.run('confirmation de réinitialisation', async () => {
      await this.sendQuietly(
        buildPasswordChangedEmail({ to: outcome.email, fullName: outcome.fullName, tenantName: outcome.tenantName, tenantSlug: outcome.tenantSlug, webUrl: this.env.WEB_URL }),
      );
    });
  }

  private async process(input: ForgotPasswordInput): Promise<void> {
    const rows = await this.tenantDb.runWithoutTenant((tx) =>
      tx.$queryRaw<{ id: string; status: string }[]>`SELECT id::text AS id, status::text AS status FROM platform.resolve_tenant(${input.tenantSlug})`,
    );
    const tenant = rows[0];
    if (!tenant || !SESSION_TENANT_STATUSES.has(tenant.status)) return;
    const issued = await this.tenantDb.runAs(tenant.id, (tx) => this.issueToken(tx, tenant.id, input.email));
    if (!issued) return;
    await this.sendQuietly(
      buildPasswordResetEmail({
        to: issued.email,
        fullName: issued.fullName,
        tenantName: issued.tenantName,
        tenantSlug: input.tenantSlug,
        webUrl: this.env.WEB_URL,
        token: issued.token,
        ttlMinutes: TTL_MINUTES,
      }),
    );
  }

  /**
   * Utilisateur actif avec mot de passe : les jetons précédents sont invalidés puis un nouveau est créé. Un jeton émis il y a
   * moins de 10 minutes reste valable et aucune nouvelle demande n'est émise : des demandes répétées (ou d'un tiers) ne
   * peuvent ni invalider le lien que l'utilisateur vient de recevoir, ni inonder sa boîte.
   */
  private async issueToken(tx: TenantTx, tenantId: string, email: string) {
    const user = await tx.user.findUnique({
      where: { tenantId_email: { tenantId, email } },
      select: { id: true, email: true, fullName: true, status: true, deletedAt: true, credential: { select: { userId: true } } },
    });
    if (!user || user.status !== 'active' || user.deletedAt || !user.credential) return undefined;
    const now = this.clock.now();
    if (await this.hasRecentToken(tx, tenantId, user.id, now)) return undefined;
    await invalidatePasswordResetTokens(tx, tenantId, user.id, now);
    const issued = issueOpaqueToken(tenantId);
    await tx.passwordResetToken.create({
      data: {
        tenantId,
        userId: user.id,
        tokenHash: issued.hash,
        createdAt: now,
        expiresAt: new Date(now.getTime() + PASSWORD_RESET_TTL_MS),
        requestedIp: this.sessions.clientMeta().ip,
      },
    });
    await this.audit.record(tx, tenantId, { action: 'auth.password.reset_requested', actorUserId: user.id, actorType: 'user', resourceType: 'user', resourceId: user.id });
    const profile = await loadTenantProfile(tx);
    return { token: issued.token, email: user.email, fullName: user.fullName, tenantName: profile.name };
  }

  /** Jeton ouvert émis il y a moins de 10 minutes ; le verrou de la ligne utilisateur sérialise les demandes simultanées. */
  private async hasRecentToken(tx: TenantTx, tenantId: string, userId: string, now: Date): Promise<boolean> {
    await tx.$queryRaw`SELECT id FROM tenant.users WHERE tenant_id = ${tenantId}::uuid AND id = ${userId}::uuid FOR UPDATE`;
    const recent = await tx.passwordResetToken.findFirst({
      where: { tenantId, userId, consumedAt: null, expiresAt: { gt: now }, createdAt: { gt: new Date(now.getTime() - PASSWORD_RESET_REISSUE_AFTER_MS) } },
      select: { id: true },
    });
    return recent !== null;
  }

  /** Jeton utilisable : inconnu, expiré, consommé, brûlé, utilisateur non actif ou tenant inactif ⇒ `undefined`. */
  private async loadUsable(tx: TenantTx, tenantId: string, tokenHash: Uint8Array<ArrayBuffer>, now: Date): Promise<LoadedReset | undefined> {
    const token = await tx.passwordResetToken.findUnique({ where: { tenantId_tokenHash: { tenantId, tokenHash } } });
    if (!token || token.consumedAt || token.expiresAt <= now || token.attempts >= PASSWORD_RESET_MAX_MFA_ATTEMPTS) return undefined;
    const user = await tx.user.findUnique({
      where: { tenantId_id: { tenantId, id: token.userId } },
      select: {
        email: true,
        fullName: true,
        status: true,
        deletedAt: true,
        credential: { select: { userId: true } },
        mfaFactors: { where: { kind: TOTP_KIND, activatedAt: { not: null } }, select: { id: true, secretEnc: true, lastUsedStep: true, userId: true } },
      },
    });
    if (!user || user.status !== 'active' || user.deletedAt || !user.credential) return undefined;
    const tenantStatus = (await this.authz.loadTenantModules(tx)).status;
    if (!tenantStatus || !SESSION_TENANT_STATUSES.has(tenantStatus)) return undefined;
    return { tokenId: token.id, userId: token.userId, email: user.email, fullName: user.fullName, factor: user.mfaFactors[0] ?? null };
  }

  private async attemptReset(
    tx: TenantTx,
    tenantId: string,
    tokenHash: Uint8Array<ArrayBuffer>,
    newHash: string,
    mfaCode: string | undefined,
  ): Promise<ResetOutcome> {
    const now = this.clock.now();
    // Relu sous transaction : le jeton a pu être consommé, brûlé ou expirer depuis la lecture préalable.
    const loaded = await this.loadUsable(tx, tenantId, tokenHash, now);
    if (!loaded) return { kind: 'invalid_token' };
    if (loaded.factor && !mfaCode) return { kind: 'mfa_required' };

    // Essai réservé AVANT la vérification, sous verrou de ligne : deux requêtes concurrentes ne réussissent pas toutes deux.
    const claimed = await tx.passwordResetToken.updateMany({
      where: { tenantId, id: loaded.tokenId, consumedAt: null, expiresAt: { gt: now }, attempts: { lt: PASSWORD_RESET_MAX_MFA_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (claimed.count === 0) return { kind: 'invalid_token' };

    if (loaded.factor && mfaCode && !(await this.codes.check(tx, tenantId, loaded.factor, mfaCode))) {
      return this.recordWrongCode(tx, tenantId, loaded, now);
    }
    return this.complete(tx, tenantId, loaded, newHash, now);
  }

  private async recordWrongCode(tx: TenantTx, tenantId: string, loaded: LoadedReset, now: Date): Promise<ResetOutcome> {
    const token = await tx.passwordResetToken.findUniqueOrThrow({ where: { tenantId_id: { tenantId, id: loaded.tokenId } }, select: { attempts: true } });
    const burned = token.attempts >= PASSWORD_RESET_MAX_MFA_ATTEMPTS;
    if (burned) await tx.passwordResetToken.update({ where: { tenantId_id: { tenantId, id: loaded.tokenId } }, data: { consumedAt: now } });
    await this.audit.record(tx, tenantId, {
      action: 'auth.password.reset_failed',
      outcome: 'failure',
      actorUserId: loaded.userId,
      actorType: 'user',
      resourceType: 'user',
      resourceId: loaded.userId,
      changes: { reason: burned ? 'token_burned' : 'invalid_mfa' },
    });
    return { kind: 'wrong_code', userId: loaded.userId, fullName: loaded.fullName };
  }

  private async complete(tx: TenantTx, tenantId: string, loaded: LoadedReset, newHash: string, now: Date): Promise<ResetOutcome> {
    await tx.passwordResetToken.update({ where: { tenantId_id: { tenantId, id: loaded.tokenId } }, data: { consumedAt: now } });
    await invalidatePasswordResetTokens(tx, tenantId, loaded.userId, now);
    await tx.userCredential.update({
      where: { tenantId_userId: { tenantId, userId: loaded.userId } },
      data: { passwordHash: newHash, passwordChangedAt: now, mustChangePassword: false, failedAttempts: 0 },
    });
    await tx.user.updateMany({ where: { tenantId, id: loaded.userId, emailVerifiedAt: null }, data: { emailVerifiedAt: now } });
    const revoked = await tx.session.updateMany({
      where: { tenantId, userId: loaded.userId, revokedAt: null },
      data: { revokedAt: now, revokedReason: 'password_reset' },
    });
    await this.audit.record(tx, tenantId, {
      action: 'auth.password.reset_completed',
      actorUserId: loaded.userId,
      actorType: 'user',
      resourceType: 'user',
      resourceId: loaded.userId,
      changes: { revokedSessions: revoked.count },
    });
    const profile = await loadTenantProfile(tx);
    return { kind: 'done', email: loaded.email, fullName: loaded.fullName, tenantName: profile.name, tenantSlug: profile.slug };
  }

  private async sendQuietly(message: Parameters<Mailer['send']>[0]): Promise<void> {
    try {
      await this.mailer.send(message);
    } catch (error: unknown) {
      // Ni l'adresse ni le message (qui peut porter le lien) ne sont journalisés.
      this.logger.warn(`Envoi d’un e-mail de sécurité en échec (${error instanceof Error ? error.name : 'inconnue'}).`);
    }
  }
}
