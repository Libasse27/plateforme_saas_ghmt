import { createHash } from 'node:crypto';
import { SetMetadata, type ExecutionContext } from '@nestjs/common';
import type { ThrottlerOptions } from '@nestjs/throttler';
import { parseOpaqueToken } from '../auth/opaque-token';
import { ipRateLimitKey } from './ip-bucket';

/** Nom du limiteur indexé sur le compte visé (en plus du limiteur par IP `default`). */
export const ACCOUNT_THROTTLER_NAME = 'account';
export const ACCOUNT_THROTTLE_KEY = 'ghmt:account-throttle';

const FIFTEEN_MINUTES_MS = 15 * 60_000;
/** Tentatives par compte et par fenêtre : borne les attaques réparties sur de nombreuses IP. */
export const ACCOUNT_THROTTLE_LIMIT = 30;

export type AccountThrottleKind = 'login' | 'mfa' | 'password_forgot' | 'password_reset' | 'signup_resend';

/** Active le limiteur « compte » sur une route (login : tenantSlug|email ; mfa/verify : challengeId). */
export const AccountThrottled = (kind: AccountThrottleKind): MethodDecorator => SetMetadata(ACCOUNT_THROTTLE_KEY, kind);

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * Jeton opaque sous la forme que le service retiendra (`parseOpaqueToken` : tenant en minuscules, secret exact) : varier la
 * casse de l'identifiant d'établissement ne donne pas un nouveau seau. Jeton illisible : valeur reçue telle quelle.
 */
function normalizedOpaqueToken(token: string): string {
  const parsed = parseOpaqueToken(token);
  return parsed ? `${parsed.tenantId}.${token.slice(token.indexOf('.') + 1)}` : token;
}

function asText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 ? value.trim().toLowerCase() : undefined;
}

/**
 * Clé du limiteur « compte » : `sha256(tenantSlug|email)` pour login, `sha256(challengeId)` pour mfa/verify,
 * `sha256(pwd|slug|email)`, `sha256(signup|slug|email)` et `sha256(reset|jeton)` (jeton normalisé comme `parseOpaqueToken`) pour les autres.
 * Corps inexploitable ⇒ repli sur l'IP, regroupée comme le limiteur par IP (IPv6 par /64) : jamais un seau partagé par
 * tous les corps invalides.
 */
export function accountTracker(kind: AccountThrottleKind | undefined, body: unknown, ip: string | undefined): string {
  const fields = (body ?? {}) as Record<string, unknown>;
  if (kind === 'login') {
    const slug = asText(fields['tenantSlug']);
    const email = asText(fields['email']);
    if (slug && email) return sha256Hex(`${slug}|${email}`);
  }
  if (kind === 'password_forgot' || kind === 'signup_resend') {
    const slug = asText(fields['tenantSlug']);
    const email = asText(fields['email']);
    const prefix = kind === 'password_forgot' ? 'pwd' : 'signup';
    if (slug && email) return sha256Hex(`${prefix}|${slug}|${email}`);
  }
  if (kind === 'password_reset') {
    const token = typeof fields['token'] === 'string' && fields['token'].length > 0 && fields['token'].length <= 512 ? fields['token'] : undefined;
    if (token) return sha256Hex(`reset|${normalizedOpaqueToken(token)}`);
  }
  if (kind === 'mfa') {
    const challenge = asText(fields['challengeId']);
    if (challenge) return sha256Hex(`mfa|${challenge}`);
  }
  return `ip:${ipRateLimitKey(ip)}`;
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
