import { isIP } from 'node:net';

const HEXTETS = 8;
/** Hextets conservés : un client IPv6 reçoit en général un /64 entier, dont il choisit librement les 64 bits bas. */
const PREFIX_HEXTETS = 4;
const IPV6_BUCKET_PREFIX = PREFIX_HEXTETS * 16;
const MAPPED_V4_MARKER = 0xffff;
const UNKNOWN = 'unknown';

/** IPv6 (déjà validée par `isIP`) développée en 8 hextets ; notation à IPv4 finale prise en charge. */
function toHextets(address: string): number[] {
  const lastColon = address.lastIndexOf(':');
  const tail = address.slice(lastColon + 1);
  const head = tail.includes('.') ? `${address.slice(0, lastColon + 1)}${ipv4ToHextets(tail).join(':')}` : address;
  const [left = '', right] = head.split('::');
  const leftGroups = left ? left.split(':') : [];
  const rightGroups = right ? right.split(':') : [];
  const fill = right === undefined ? [] : new Array<string>(HEXTETS - leftGroups.length - rightGroups.length).fill('0');
  return [...leftGroups, ...fill, ...rightGroups].map((group) => parseInt(group, 16));
}

function ipv4ToHextets(ipv4: string): string[] {
  const [a = 0, b = 0, c = 0, d = 0] = ipv4.split('.').map(Number);
  return [((a << 8) | b).toString(16), ((c << 8) | d).toString(16)];
}

function isMappedV4(hextets: readonly number[]): boolean {
  return hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === MAPPED_V4_MARKER;
}

function mappedToIpv4(hextets: readonly number[]): string {
  const high = hextets[6] ?? 0;
  const low = hextets[7] ?? 0;
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join('.');
}

/**
 * Seau du limiteur par IP (fonction pure) : IPv4 inchangée, IPv4 encapsulée (`::ffff:a.b.c.d`) ramenée à l'IPv4, IPv6
 * regroupée par /64 (`2001:db8:1:2::/64`) pour qu'un client ne multiplie pas ses quotas en changeant d'adresse dans son
 * préfixe. Identifiant de zone ignoré ; valeur qui n'est pas une IP rendue telle quelle, absence ⇒ `unknown`.
 */
export function ipRateLimitKey(ip: string | undefined): string {
  if (!ip) return UNKNOWN;
  const bare = ip.split('%')[0] ?? ip;
  const version = isIP(bare);
  if (version === 4) return bare;
  if (version !== 6) return ip;
  const hextets = toHextets(bare.toLowerCase());
  if (isMappedV4(hextets)) return mappedToIpv4(hextets);
  return `${hextets.slice(0, PREFIX_HEXTETS).map((h) => h.toString(16)).join(':')}::/${IPV6_BUCKET_PREFIX}`;
}
