import { createHash } from 'node:crypto';
import { SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { ThrottlerOptions } from '@nestjs/throttler';

/** Nom du limiteur indexé sur le compte visé (en plus du limiteur par IP `default`). */
export const ACCOUNT_THROTTLER_NAME = 'account';
export const ACCOUNT_THROTTLE_KEY = 'ghmt:account-throttle';

const FIFTEEN_MINUTES_MS = 15 * 60_000;
/** Tentatives par compte et par fenêtre : borne les attaques réparties sur de nombreuses IP. */
export const ACCOUNT_THROTTLE_LIMIT = 30;

export type AccountThrottleKind = 'login' | 'mfa';

/** Active le limiteur « compte » sur une route (login : tenantSlug|email ; mfa/verify : challengeId). */
export const AccountThrottled = (kind: AccountThrottleKind): MethodDecorator => SetMetadata(ACCOUNT_THROTTLE_KEY, kind);

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value.trim().toLowerCase() : undefined;
}

/**
 * Clé du limiteur « compte » : `sha256(tenantSlug|email)` pour login, `sha256(challengeId)` pour mfa/verify.
 * Corps inexploitable ⇒ repli sur l'IP (jamais un seau partagé par tous les corps invalides).
 */
export function accountTracker(kind: AccountThrottleKind | undefined, body: unknown, ip: string | undefined): string {
  const fields = (body ?? {}) as Record<string, unknown>;
  if (kind === 'login') {
    const slug = asText(fields['tenantSlug']);
    const email = asText(fields['email']);
    if (slug && email) return sha256Hex(`${slug}|${email}`);
  }
  if (kind === 'mfa') {
    const challenge = asText(fields['challengeId']);
    if (challenge) return sha256Hex(`mfa|${challenge}`);
  }
  return `ip:${ip ?? 'unknown'}`;
}

/** Configuration du limiteur « compte » pour ThrottlerModule : ignoré sur les routes non décorées. */
export const ACCOUNT_THROTTLER: ThrottlerOptions = {
  name: ACCOUNT_THROTTLER_NAME,
  ttl: FIFTEEN_MINUTES_MS,
  limit: ACCOUNT_THROTTLE_LIMIT,
  skipIf: (context: ExecutionContext) => Reflect.getMetadata(ACCOUNT_THROTTLE_KEY, context.getHandler()) === undefined,
  getTracker: (req, context) =>
    accountTracker(Reflect.getMetadata(ACCOUNT_THROTTLE_KEY, context.getHandler()) as AccountThrottleKind | undefined, req['body'], req['ip'] as string | undefined),
};
