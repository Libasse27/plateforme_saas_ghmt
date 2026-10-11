import { createHash } from 'node:crypto';
import type { Logger } from '@nestjs/common';
import { SIGNUP_VERIFICATION_TTL_HOURS } from '@ghmt/shared';
import { issueOpaqueToken } from '../../common/auth/opaque-token';
import type { AuditService } from '../../common/audit/audit.service';
import { buildSignupVerificationEmail } from '../../common/mail/signup-verification-email';
import type { Mailer } from '../../common/mail/mailer';
import type { RateLimitStore } from '../../common/rate-limit/rate-limit-store';
import type { TenantDb, TenantTx } from '../../infrastructure/prisma/tenant-db.service';
import { SIGNUP_MAIL_PER_ADDRESS_LIMIT, SIGNUP_MAIL_PER_ADDRESS_WINDOW_MS, SIGNUP_VERIFICATION_TTL_MS } from './onboarding.constants';

/** Crée un jeton de vérification pour l'utilisateur ; seule son empreinte est stockée. Renvoie le jeton en clair. */
export async function createSignupVerification(tx: TenantTx, params: { tenantId: string; userId: string; now: Date }): Promise<string> {
  const issued = issueOpaqueToken(params.tenantId);
  await tx.signupVerification.create({
    data: {
      tenantId: params.tenantId,
      userId: params.userId,
      tokenHash: issued.hash,
      expiresAt: new Date(params.now.getTime() + SIGNUP_VERIFICATION_TTL_MS),
    },
  });
  return issued.token;
}

/** Invalide les jetons encore ouverts de l'utilisateur (renvoi : seul le dernier lien fonctionne). */
export async function invalidateOpenSignupVerifications(tx: TenantTx, params: { tenantId: string; userId: string; now: Date }): Promise<void> {
  await tx.signupVerification.updateMany({
    where: { tenantId: params.tenantId, userId: params.userId, consumedAt: null },
    data: { consumedAt: params.now },
  });
}

export interface SignupVerificationDelivery {
  readonly tenantId: string;
  readonly userId: string;
  readonly email: string;
  readonly tenantSlug: string;
  readonly token: string;
  readonly resend: boolean;
}

export interface SignupVerificationDeliveryDeps {
  readonly mailer: Mailer;
  readonly tenantDb: TenantDb;
  readonly audit: AuditService;
  readonly store: RateLimitStore;
  readonly webUrl: string;
  readonly logger: Pick<Logger, 'warn'>;
}

/**
 * Envoie l'e-mail de vérification (hors outbox : le jeton ne doit pas être stocké) puis audite l'envoi.
 * Un échec est journalisé (classe d'erreur seule : ni jeton, ni adresse) et n'est jamais propagé : l'inscription
 * est déjà validée et l'utilisateur dispose du renvoi. Renvoie vrai si l'e-mail est parti.
 */
export async function deliverSignupVerification(deps: SignupVerificationDeliveryDeps, delivery: SignupVerificationDelivery): Promise<boolean> {
  if (await addressLimitReached(deps, delivery.email)) return false;
  try {
    await deps.mailer.send(
      buildSignupVerificationEmail({
        to: delivery.email,
        tenantSlug: delivery.tenantSlug,
        webUrl: deps.webUrl,
        token: delivery.token,
        ttlHours: SIGNUP_VERIFICATION_TTL_HOURS,
      }),
    );
  } catch (error: unknown) {
    deps.logger.warn({ errorClass: error instanceof Error ? error.name : 'unknown', resend: delivery.resend }, 'Envoi de l’e-mail de vérification d’inscription impossible');
    return false;
  }
  try {
    await deps.tenantDb.runAs(delivery.tenantId, (tx) =>
      deps.audit.record(tx, delivery.tenantId, {
        action: 'tenant.signup_verification_sent',
        actorType: 'user',
        actorUserId: delivery.userId,
        resourceType: 'user',
        resourceId: delivery.userId,
        changes: { resend: delivery.resend, ttlHours: SIGNUP_VERIFICATION_TTL_HOURS },
      }),
    );
  } catch (error: unknown) {
    deps.logger.warn({ errorClass: error instanceof Error ? error.name : 'unknown' }, 'Audit de l’envoi de vérification impossible');
  }
  return true;
}

/**
 * Limite par ADRESSE DE DESTINATION (docs/11 §14.3.4), tous établissements confondus : empêche d'inonder la boîte d'un tiers
 * avec des inscriptions répétées. La clé est une empreinte (jamais l'adresse). Au-delà : aucun envoi, journal sans adresse.
 */
async function addressLimitReached(deps: SignupVerificationDeliveryDeps, email: string): Promise<boolean> {
  const key = `signup-mail:${createHash('sha256').update(email.trim().toLowerCase()).digest('hex')}`;
  const hit = await deps.store.hit(key, SIGNUP_MAIL_PER_ADDRESS_WINDOW_MS, SIGNUP_MAIL_PER_ADDRESS_LIMIT, 0);
  if (hit.isBlocked) deps.logger.warn({ reason: 'address_rate_limited' }, 'E-mail de vérification non envoyé : limite par adresse atteinte');
  return hit.isBlocked;
}
