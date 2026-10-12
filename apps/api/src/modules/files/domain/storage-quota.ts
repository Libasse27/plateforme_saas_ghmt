import type { LimitViolation } from '../../../common/authz/entitlement-rules';

const BYTES_PER_GB = 1024 ** 3;
const DISPLAY_DECIMALS = 100;

/**
 * Quota de stockage (docs/13 D6) : le dépôt est refusé si l'usage (fichiers `pending` et `available`) augmenté de sa taille
 * dépasse `storageGb`. `null` = illimité. La violation porte la limite et l'usage courant en Go (2 décimales).
 */
export function storageQuotaViolation(limitGb: number | null, usedBytes: number, addedBytes: number): LimitViolation | null {
  if (limitGb === null) return null;
  if (usedBytes + addedBytes <= limitGb * BYTES_PER_GB) return null;
  return { limit: limitGb, current: Math.round((usedBytes / BYTES_PER_GB) * DISPLAY_DECIMALS) / DISPLAY_DECIMALS };
}
