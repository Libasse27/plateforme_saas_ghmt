import QRCode from 'qrcode';
import { rec, strings } from './raw';

const OTPAUTH_PREFIX = 'otpauth://';

export interface TotpSetup {
  readonly qrDataUrl: string;
  readonly secret: string;
}

/** Le QR code est généré côté serveur (aucune bibliothèque dans le navigateur) ; null si la réponse est inattendue. */
export async function buildTotpSetup(raw: unknown): Promise<TotpSetup | null> {
  const { otpauthUrl, secret } = rec(raw);
  if (typeof otpauthUrl !== 'string' || !otpauthUrl.startsWith(OTPAUTH_PREFIX) || typeof secret !== 'string') return null;
  const svg = await QRCode.toString(otpauthUrl, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
  return { qrDataUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`, secret };
}

export function backupCodesOf(raw: unknown): string[] {
  return strings(rec(raw).backupCodes);
}
