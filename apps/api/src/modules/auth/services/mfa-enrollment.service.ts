import { Inject, Injectable } from '@nestjs/common';
import type { MfaEmailCodeResponse, MfaSetupInput, TotpActivateResponse, TotpSetupResponse } from '@ghmt/shared';
import { AuditService } from '../../../common/audit/audit.service';
import { AuthorizationService } from '../../../common/authz/authorization.service';
import { RequestContext, type Principal } from '../../../common/context/request-context';
import { MAILER, type Mailer } from '../../../common/mail/mailer';
import { buildMfaEmailCodeEmail } from '../../../common/mail/security-emails';
import { Clock } from '../../../common/time/clock';
import { ENV, type Env } from '../../../infrastructure/config/env';
import { loadTenantProfile } from '../../../infrastructure/tenancy/tenant-profile';
import { maskEmail } from '../../notifications/domain/masking';
import { MFA_EMAIL_CODE_MAX_ATTEMPTS, MFA_EMAIL_CODE_MAX_SENDS, MFA_EMAIL_CODE_TTL_MS, MFA_EMAIL_CODE_WINDOW_MS } from '../auth.constants';
import { deriveEmailCodeKey, emailCodeMatches, generateEmailCode, hashEmailCode } from './mfa-email-code';
import { FieldCrypto } from '../../../common/crypto/field-crypto.service';
import { DomainError } from '../../../common/errors/domain-error';
import { TenantDb, type TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { TOTP_KIND } from '../auth.constants';
import { generateBackupCodes, hashBackupCode } from './backup-codes';
import { SessionService } from './session.service';
import { TotpService } from './totp.service';

@Injectable()
export class MfaEnrollmentService {
  constructor(
    private readonly tenantDb: TenantDb,
    private readonly totp: TotpService,
    private readonly crypto: FieldCrypto,
    private readonly audit: AuditService,
    private readonly sessions: SessionService,
    private readonly authz: AuthorizationService,
    private readonly context: RequestContext,
    private readonly clock: Clock,
    @Inject(MAILER) private readonly mailer: Mailer,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Envoie par e-mail le code exigé pour enrôler un TOTP hors réseau de confiance (docs/11 D7), lié à la session courante. */
  async sendEmailCode(principal: Principal): Promise<MfaEmailCodeResponse> {
    const { tenantId, userId, sessionId } = principal;
    const now = this.clock.now();
    const code = generateEmailCode();
    const key = deriveEmailCodeKey(this.env.BLIND_INDEX_KEY);

    const prepared = await this.tenantDb.run(async (tx) => {
      await this.assertNotEnrolled(tx, tenantId, userId);
      const network = await this.authz.loadNetworkPolicy(tx, this.context.state?.ip);
      if (network.networkTrusted) throw DomainError.unprocessable('email_code_not_required', 'Aucun code n’est exigé depuis le réseau de l’établissement.');
      await this.assertCanSendEmailCode(tx, tenantId, userId, now);
      await tx.mfaEmailCode.updateMany({ where: { tenantId, sessionId, consumedAt: null }, data: { consumedAt: now } });
      await tx.mfaEmailCode.create({
        data: { tenantId, userId, sessionId, codeHash: hashEmailCode(key, userId, sessionId, code), expiresAt: new Date(now.getTime() + MFA_EMAIL_CODE_TTL_MS) },
      });
      await this.audit.record(tx, tenantId, { action: 'auth.mfa.email_code_sent', resourceType: 'user', resourceId: userId });
      const user = await tx.user.findUniqueOrThrow({ where: { tenantId_id: { tenantId, id: userId } }, select: { email: true, fullName: true } });
      const profile = await loadTenantProfile(tx);
      return { ...user, tenantName: profile.name, tenantSlug: profile.slug };
    });

    try {
      await this.mailer.send(
        buildMfaEmailCodeEmail({ to: prepared.email, fullName: prepared.fullName, tenantName: prepared.tenantName, tenantSlug: prepared.tenantSlug, webUrl: this.env.WEB_URL, code, ttlMinutes: MFA_EMAIL_CODE_TTL_MS / 60_000 }),
      );
    } catch {
      // Le message pourrait citer le code : aucune cause n'est conservée.
      throw new DomainError('email_code_send_failed', 502, 'Bad Gateway', 'Le code n’a pas pu être envoyé. Réessayez dans quelques instants.');
    }
    return { sent: true, emailMasked: maskEmail(prepared.email) };
  }

  /**
   * Au plus 3 envois par utilisateur et par 15 minutes, comptés de façon atomique : le verrou de la ligne utilisateur sérialise
   * les demandes simultanées, chacune compte les codes validés par les précédentes.
   */
  private async assertCanSendEmailCode(tx: TenantTx, tenantId: string, userId: string, now: Date): Promise<void> {
    await tx.$queryRaw`SELECT id FROM tenant.users WHERE tenant_id = ${tenantId}::uuid AND id = ${userId}::uuid FOR UPDATE`;
    const recent = await tx.mfaEmailCode.count({ where: { tenantId, userId, createdAt: { gt: new Date(now.getTime() - MFA_EMAIL_CODE_WINDOW_MS) } } });
    if (recent >= MFA_EMAIL_CODE_MAX_SENDS) throw DomainError.tooManyRequests(Math.ceil(MFA_EMAIL_CODE_WINDOW_MS / 1000));
  }

  private async assertNotEnrolled(tx: TenantTx, tenantId: string, userId: string): Promise<void> {
    const existing = await tx.mfaFactor.findUnique({ where: { tenantId_userId_kind: { tenantId, userId, kind: TOTP_KIND } } });
    if (existing?.activatedAt) throw DomainError.conflict('mfa_already_enrolled', 'Un second facteur est déjà activé.');
  }

  /** Vérifie le code e-mail de la session (5 essais, usage unique). Renvoie `false` si faux : l'échec doit être validé avant d'être signalé. */
  private async consumeEmailCode(tx: TenantTx, principal: Principal, code: string, now: Date): Promise<boolean> {
    const { tenantId, userId, sessionId } = principal;
    const row = await tx.mfaEmailCode.findFirst({
      where: { tenantId, userId, sessionId, consumedAt: null, expiresAt: { gt: now }, attempts: { lt: MFA_EMAIL_CODE_MAX_ATTEMPTS } },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) return false;
    const reserved = await tx.mfaEmailCode.updateMany({
      where: { tenantId, id: row.id, consumedAt: null, attempts: { lt: MFA_EMAIL_CODE_MAX_ATTEMPTS } },
      data: { attempts: { increment: 1 } },
    });
    if (reserved.count === 0) return false;
    const candidate = hashEmailCode(deriveEmailCodeKey(this.env.BLIND_INDEX_KEY), userId, sessionId, code);
    if (!emailCodeMatches(row.codeHash, candidate)) {
      await this.audit.record(tx, tenantId, { action: 'auth.mfa.email_code_failed', outcome: 'failure', resourceType: 'user', resourceId: userId, changes: { attempt: row.attempts + 1 } });
      return false;
    }
    const consumed = await tx.mfaEmailCode.updateMany({ where: { tenantId, id: row.id, consumedAt: null }, data: { consumedAt: now } });
    return consumed.count === 1;
  }

  /** Génère un secret chiffré dans un facteur non activé (un enrôlement abandonné est remplacé). */
  async setup(principal: Principal, input: MfaSetupInput = {}): Promise<TotpSetupResponse> {
    const { tenantId, userId } = principal;
    const secret = this.totp.generateSecret();
    const secretEnc = this.crypto.encrypt(tenantId, secret);
    const now = this.clock.now();

    const result = await this.tenantDb.run(async (tx) => {
      await this.assertNotEnrolled(tx, tenantId, userId);
      // Hors réseau de confiance, le code reçu par e-mail est obligatoire : le TOFU hors réseau est fermé (docs/11 D7).
      const network = await this.authz.loadNetworkPolicy(tx, this.context.state?.ip);
      if (!network.networkTrusted) {
        if (!input.emailCode) throw DomainError.forbidden('mfa_email_code_required', 'Un code reçu par e-mail est requis pour configurer le second facteur depuis ce réseau.');
        if (!(await this.consumeEmailCode(tx, principal, input.emailCode, now))) return { kind: 'bad_code' as const };
      }
      await tx.mfaFactor.upsert({
        where: { tenantId_userId_kind: { tenantId, userId, kind: TOTP_KIND } },
        create: { tenantId, userId, kind: TOTP_KIND, secretEnc },
        update: { secretEnc, lastUsedStep: null, backupCodeHashes: [] },
      });
      const user = await tx.user.findUniqueOrThrow({ where: { tenantId_id: { tenantId, id: userId } }, select: { email: true } });
      await this.audit.record(tx, tenantId, { action: 'auth.mfa.setup_started', resourceType: 'mfa_factor' });
      return { kind: 'ok' as const, email: user.email };
    });
    // L'échec (compteur d'essais, audit) est validé avant d'être signalé.
    if (result.kind === 'bad_code') throw DomainError.unprocessable('invalid_email_code', 'Code de vérification invalide ou expiré.');
    return { otpauthUrl: this.totp.buildUri(secret, result.email), secret };
  }

  /** Active le facteur, renvoie les codes de secours (une seule fois) et un jeton d'accès mfa=true. */
  async activate(principal: Principal, code: string): Promise<TotpActivateResponse> {
    const { tenantId, userId, sessionId } = principal;
    const now = new Date();

    const backupCodes = await this.tenantDb.run(async (tx) => {
      const factor = await tx.mfaFactor.findUnique({ where: { tenantId_userId_kind: { tenantId, userId, kind: TOTP_KIND } } });
      if (!factor || factor.activatedAt) throw DomainError.unprocessable('mfa_not_pending', 'Aucun enrôlement en cours.');

      const result = await this.totp.verify(this.crypto.decrypt(tenantId, factor.secretEnc), code);
      if (!result.valid) throw DomainError.unprocessable('invalid_code', 'Code de vérification invalide.');

      const codes = generateBackupCodes();
      const activated = await tx.mfaFactor.updateMany({
        where: { tenantId, id: factor.id, activatedAt: null },
        data: {
          activatedAt: now,
          lastUsedStep: BigInt(result.step),
          backupCodeHashes: codes.map((c) => hashBackupCode(userId, c)),
        },
      });
      if (activated.count === 0) throw DomainError.unprocessable('mfa_not_pending', 'Aucun enrôlement en cours.');
      await tx.session.update({ where: { tenantId_id: { tenantId, id: sessionId } }, data: { mfaVerifiedAt: now }, select: { id: true } });
      await this.audit.record(tx, tenantId, { action: 'auth.mfa.activated', resourceType: 'mfa_factor', resourceId: factor.id });
      return codes;
    });

    const accessToken = await this.sessions.signAccessToken({ ...principal, mfa: true });
    return { accessToken, expiresIn: this.sessions.accessTokenTtlSeconds, backupCodes };
  }
}
