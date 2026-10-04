import { isIP } from 'node:net';

export interface ClientInfo {
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

const MAX_USER_AGENT_LENGTH = 300;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

function validIp(value: string | null | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate && isIP(candidate) !== 0 ? candidate : undefined;
}

/**
 * Identifie le client à partir des en-têtes de la requête entrante (contexte serveur uniquement).
 * Le proxy amont de confiance ajoute l'adresse réelle en FIN de x-forwarded-for : les entrées
 * précédentes sont fournies par le navigateur et ne sont jamais crues.
 */
export function extractClientInfo(headers: Pick<Headers, 'get'>): ClientInfo {
  const chain = (headers.get('x-forwarded-for') ?? '').split(',');
  const forwarded = validIp(chain[chain.length - 1]);
  const userAgent = (headers.get('user-agent') ?? '').replace(CONTROL_CHARS, '').slice(0, MAX_USER_AGENT_LENGTH);
  return {
    ip: forwarded ?? validIp(headers.get('x-real-ip')),
    userAgent: userAgent.length > 0 ? userAgent : undefined,
  };
}

/** C9 : en-têtes envoyés à l'API sur chaque appel. */
export function forwardHeaders(info: ClientInfo | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (info?.ip) headers['x-forwarded-for'] = info.ip;
  if (info?.userAgent) headers['user-agent'] = info.userAgent;
  return headers;
}
