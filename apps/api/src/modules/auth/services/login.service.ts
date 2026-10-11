import { Injectable } from '@nestjs/common';
import type { LoginInput, LoginResponse } from '@ghmt/shared';
import { PasswordService } from '../../../common/auth/password.service';
import { AuditService } from '../../../common/audit/audit.service';
import { DomainError } from '../../../common/errors/domain-error';
import { Clock } from '../../../common/time/clock';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { MFA_CHALLENGE_TTL_MS, SESSION_TENANT_STATUSES, TOTP_KIND } from '../auth.constants';
import { registerFailedAttempt } from './failed-attempts';
import { LoginCompletionService } from './login-completion.service';
import { LoginDelayEventsService } from './login-delay-events.service';
import { LoginContextService } from './login-context.service';
import { LoginDelayService, type LoginContext } from './login-delay.service';
import { issueOpaqueToken } from '../../../common/auth/opaque-token';
import { SessionService } from './session.service';

interface ResolvedTenant {
  readonly id: string;
  readonly status: string;
}

/** Statuts de tenant qui permettent d'examiner un mot de passe ; `pending` aboutit à `email_verification_required`. */
const LOGIN_TENANT_STATUSES: ReadonlySet<string> = new Set([...SESSION_TENANT_STATUSES, 'pending']);

type FailureReason = 'unknown_user' | 'bad_password' | 'inactive';

interface LoadedUser {
  readonly id: string;
  readonly email: string;
  readonly fullName: string;
  readonly status: string;
  readonly deletedAt: Date | null;
  readonly credential: { passwordHash: string } | null;
  readonly hasMfaFactor: boolean;
}

@Injectable()
export class LoginService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly passwords: PasswordService,
    private readonly audit: AuditService,
    private readonly contexts: LoginContextService,
    private readonly sessions: SessionService,
    private readonly completion: LoginCompletionService,
    private readonly delay: LoginDelayService,
    private readonly delayEvents: LoginDelayEventsService,
    private readonly clock: Clock,
  ) {}

  async login(input: LoginInput): Promise<LoginResponse> {
    const now = this.clock.now();
    // Vérification et réservation atomiques, avant toute vérification du mot de passe, même juste (docs/11 D3) : la tentative
    // admise compte d'emblée comme un échec. Contexte connu (réseau de l'établissement, IP déjà utilisée) : décisions 21 et 25.
    const admission = await this.delay.admit(input.tenantSlug, input.email, now, () => this.loginContext(input.tenantSlug, input.email, now));
    if (!admission.allowed) {
      await this.delayEvents.delayed(input.tenantSlug, input.email, admission.retryAfterSeconds, 'login');
      throw DomainError.loginDelayed(admission.retryAfterSeconds);
    }

    const tenant = await this.resolveTenant(input.tenantSlug);
    if (!tenant || !LOGIN_TENANT_STATUSES.has(tenant.status)) {
      // Même coût (Argon2id factice) et même réponse que pour un mauvais mot de passe : pas d'énumération.
      await this.passwords.verify(undefined, input.password);
      throw DomainError.invalidCredentials();
    }

    const user = await this.loadUser(tenant.id, input.email);
    const reason = this.rejectionReason(user);
    const passwordValid = await this.passwords.verify(user?.credential?.passwordHash, input.password);

    if (!user || reason || !passwordValid) {
      await this.recordFailure(tenant.id, input, user, reason ?? (user ? 'bad_password' : 'unknown_user'), admission.count);
      throw DomainError.invalidCredentials();
    }
    // Mot de passe juste mais établissement non confirmé : message dédié (jamais pour un mot de passe incorrect).
    if (tenant.status === 'pending') {
      await this.delay.release(admission);
      throw DomainError.forbidden('email_verification_required', 'Confirmez l’adresse e-mail de l’administrateur pour activer l’établissement.');
    }

    const response = await this.openOrChallenge(tenant.id, user, input.password, now);
    // Après le commit. Second facteur attendu : le mot de passe juste n'est pas un échec (un code faux sera compté par
    // `mfa/verify`) ; connexion ouverte : remise à zéro du compteur.
    if ('challengeId' in response) await this.delay.release(admission);
    else await this.delay.clear(input.tenantSlug, input.email, admission);
    return response;
  }

  private async openOrChallenge(tenantId: string, user: LoadedUser, password: string, now: Date): Promise<LoginResponse> {
    const rehash = this.passwords.needsRehash(user.credential!.passwordHash) ? await this.passwords.hash(password) : undefined;
    return this.tenantDb.runAs(
      tenantId,
      async (tx) => {
        if (rehash) {
          await tx.userCredential.update({
            where: { tenantId_userId: { tenantId, userId: user.id } },
            data: { passwordHash: rehash },
          });
        }
        if (user.hasMfaFactor) return this.createChallenge(tx, tenantId, user.id, now);
        return this.completion.complete(tx, { tenantId, userId: user.id, method: 'password', mfaVerified: false, mfaEnrolled: false });
      },
      user.id,
    );
  }

  /** Contexte de la tentative (établissement inconnu ou fermé : aucun contexte connu). */
  private async loginContext(slug: string, email: string, now: Date): Promise<LoginContext> {
    const tenant = await this.resolveTenant(slug);
    if (!tenant || !SESSION_TENANT_STATUSES.has(tenant.status)) return { ip: null, trustedNetwork: false, knownIp: false };
    return this.contexts.evaluate(tenant.id, email, now);
  }

  private async resolveTenant(slug: string): Promise<ResolvedTenant | undefined> {
    const rows = await this.tenantDb.runWithoutTenant((tx) =>
      tx.$queryRaw<ResolvedTenant[]>`SELECT id::text AS id, status::text AS status FROM platform.resolve_tenant(${slug})`,
    );
    return rows[0];
  }

  private loadUser(tenantId: string, email: string): Promise<LoadedUser | undefined> {
    return this.tenantDb.runAs(tenantId, async (tx) => {
      const user = await tx.user.findUnique({
        where: { tenantId_email: { tenantId, email } },
        select: {
          id: true,
          email: true,
          fullName: true,
          status: true,
          deletedAt: true,
          credential: { select: { passwordHash: true } },
          mfaFactors: { where: { kind: TOTP_KIND, activatedAt: { not: null } }, select: { id: true } },
        },
      });
      if (!user) return undefined;
      const { mfaFactors, ...rest } = user;
      return { ...rest, hasMfaFactor: mfaFactors.length > 0 };
    });
  }

  private rejectionReason(user: LoadedUser | undefined): FailureReason | undefined {
    if (!user?.credential) return undefined;
    return user.status !== 'active' || user.deletedAt ? 'inactive' : undefined;
  }

  private async createChallenge(tx: TenantTx, tenantId: string, userId: string, now: Date): Promise<LoginResponse> {
    const issued = issueOpaqueToken(tenantId);
    const meta = this.sessions.clientMeta();
    await tx.mfaChallenge.create({
      data: {
        tenantId,
        userId,
        tokenHash: issued.hash,
        expiresAt: new Date(now.getTime() + MFA_CHALLENGE_TTL_MS),
        ip: meta.ip,
        userAgent: meta.userAgent,
      },
    });
    await this.audit.record(tx, tenantId, { action: 'auth.login.mfa_challenge', actorUserId: userId });
    return { mfaRequired: true, challengeId: issued.token, methods: ['totp', 'backup_code'] };
  }

  /** Échec (déjà compté par `admit`) : compteur et journal dans une même transaction, puis alertes au seuil (compte actif seulement). */
  private async recordFailure(tenantId: string, input: LoginInput, user: LoadedUser | undefined, reason: FailureReason, count: number): Promise<void> {
    await this.tenantDb.runAs(
      tenantId,
      async (tx) => {
        if (user?.credential && reason !== 'inactive') await registerFailedAttempt(tx, tenantId, user.id);
        await this.audit.record(tx, tenantId, {
          action: 'auth.login.failed',
          outcome: 'failure',
          actorType: user ? 'user' : 'anonymous',
          ...(user ? { actorUserId: user.id } : {}),
          changes: { reason, delayed: false },
        });
      },
      user?.id,
    );
    // Aucune alerte pour un compte désactivé ou sans mot de passe (invité).
    if (!user?.credential || reason === 'inactive') return;
    await this.delayEvents.failureCounted({ tenantId, tenantSlug: input.tenantSlug, userId: user.id, email: user.email, fullName: user.fullName, count });
  }
}
