import { isIP } from 'node:net';
import { getEdgeProxySecret, getTrustedProxyHops } from '../config';
import { EDGE_AUTH_HEADER, edgeSecretMatches } from '../edge';

export interface ClientInfo {
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

/** Réglages de la lecture de l'IP cliente ; par défaut, issus de l'environnement (TRUSTED_PROXY_HOPS, EDGE_PROXY_SECRET). */
export interface ClientInfoOptions {
  /** Nombre de proxys de confiance devant le BFF. */
  readonly hops?: number;
  /** Secret de bordure attendu ; `undefined` ⇒ aucun contrôle (développement). */
  readonly edgeSecret?: string | undefined;
}

const MAX_USER_AGENT_LENGTH = 300;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;
const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/** Adresse valide (IPv4 ou IPv6 sans zone ni port), IPv4 encapsulée `::ffff:a.b.c.d` ramenée à l'IPv4. */
function validIp(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  if (!candidate || isIP(candidate) === 0 || candidate.includes('%')) return undefined;
  const mapped = IPV4_MAPPED.exec(candidate)?.[1];
  return mapped && isIP(mapped) === 4 ? mapped : candidate;
}

/**
 * Entrée de `x-forwarded-for` placée par le n-ième proxy de confiance en partant de la fin (docs/11 D11).
 * Les entrées antérieures sont fournies par le navigateur et ne sont jamais crues.
 */
function forwardedIp(header: string | null, hops: number): string | undefined {
  if (hops < 1) return undefined;
  const chain = (header ?? '').split(',').map((entry) => entry.trim());
  if (chain.length < hops) return undefined;
  return validIp(chain[chain.length - hops]);
}

/**
 * Identifie le client à partir des en-têtes de la requête entrante (contexte serveur uniquement).
 * - secret de bordure configuré mais absent ou faux ⇒ aucune IP (accès direct au BFF, en-têtes forgeables) ;
 * - `x-real-ip` n'est plus lu : il est contrôlable par le client dès qu'un proxy ne l'écrase pas.
 */
export function extractClientInfo(headers: Pick<Headers, 'get'>, options: ClientInfoOptions = {}): ClientInfo {
  const hops = options.hops ?? getTrustedProxyHops();
  const edgeSecret = 'edgeSecret' in options ? options.edgeSecret : getEdgeProxySecret();
  const fromEdge = edgeSecret === undefined || edgeSecretMatches(headers.get(EDGE_AUTH_HEADER), edgeSecret);
  const userAgent = (headers.get('user-agent') ?? '').replace(CONTROL_CHARS, '').slice(0, MAX_USER_AGENT_LENGTH);
  return {
    ip: fromEdge ? forwardedIp(headers.get('x-forwarded-for'), hops) : undefined,
    userAgent: userAgent.length > 0 ? userAgent : undefined,
  };
}

/** C9 : en-têtes envoyés à l'API sur chaque appel. Le secret de bordure n'est jamais transmis. */
export function forwardHeaders(info: ClientInfo | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (info?.ip) headers['x-forwarded-for'] = info.ip;
  if (info?.userAgent) headers['user-agent'] = info.userAgent;
  return headers;
}
