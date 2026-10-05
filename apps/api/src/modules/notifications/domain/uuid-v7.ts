import { randomBytes } from 'node:crypto';

const COUNTER_MAX = 0xfff;
const COUNTER_SEED_RANGE = 0x800;
let lastMs = 0;
let counter = 0;

/**
 * UUID version 7 (RFC 9562), strictement croissant dans le processus : au sein d'une même milliseconde (ou si l'horloge
 * recule), un compteur de 12 bits départage. Les pages de la boîte in-app sont triées par identifiant décroissant.
 */
export function uuidv7(nowMs: number = Date.now()): string {
  if (nowMs > lastMs) {
    lastMs = nowMs;
    counter = randomBytes(2).readUInt16BE(0) % COUNTER_SEED_RANGE;
  } else {
    counter += 1;
    if (counter > COUNTER_MAX) {
      lastMs += 1;
      counter = 0;
    }
  }
  const tail = randomBytes(8);
  tail[0] = ((tail[0] as number) & 0x3f) | 0x80;
  const time = lastMs.toString(16).padStart(12, '0');
  const versionAndCounter = (0x7000 | counter).toString(16);
  const hex = tail.toString('hex');
  return `${time.slice(0, 8)}-${time.slice(8)}-${versionAndCounter}-${hex.slice(0, 4)}-${hex.slice(4)}`;
}
