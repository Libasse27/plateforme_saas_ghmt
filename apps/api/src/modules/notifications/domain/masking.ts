import { createHmac } from 'node:crypto';

const PHONE_HEAD = 6;
const PHONE_TAIL = 2;
const PHONE_MIN_HIDDEN = 2;
const MASK = '*';
const EMAIL_MASK = '***';

/** `+22177*****45` : l'indicatif et le début du numéro, les deux derniers chiffres ; le milieu est masqué. */
export function maskPhone(phone: string): string {
  const head = Math.min(PHONE_HEAD, Math.max(1, phone.length - PHONE_TAIL - PHONE_MIN_HIDDEN));
  const hidden = Math.max(PHONE_MIN_HIDDEN, phone.length - head - PHONE_TAIL);
  return `${phone.slice(0, head)}${MASK.repeat(hidden)}${phone.slice(-PHONE_TAIL)}`;
}

/** `a***@e***.sn` : initiales de la partie locale et du domaine, suffixe conservé. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at < 1) return EMAIL_MASK;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const lastDot = domain.lastIndexOf('.');
  const maskedDomain = lastDot > 0 ? `${domain.slice(0, 1)}${EMAIL_MASK}${domain.slice(lastDot)}` : `${domain.slice(0, 1)}${EMAIL_MASK}`;
  return `${local.slice(0, 1)}${EMAIL_MASK}@${maskedDomain}`;
}

const RECIPIENT_KEY_LABEL = 'ghmt:notifications:recipient';

/** Clé dérivée de BLIND_INDEX_KEY : aucun nouveau secret de hachage (docs/10 §8). */
export function deriveRecipientKey(blindIndexKeyBase64: string): Buffer {
  return createHmac('sha256', Buffer.from(blindIndexKeyBase64, 'base64')).update(RECIPIENT_KEY_LABEL).digest();
}

/** Normalisation commune au numéro et à l'adresse : sans espaces, en minuscules. */
function normalizeAddress(address: string): string {
  return address.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '');
}

/** HMAC-SHA-256 d'une adresse ou d'un numéro (`recipient_hash`, `platform.sms_recipient_tenants.phone_hmac`). */
export function recipientHash(key: Buffer, address: string): Buffer {
  return createHmac('sha256', key).update(normalizeAddress(address)).digest();
}
