import { describe, expect, it } from 'vitest';
import { storageQuotaViolation } from './storage-quota';

const GB = 1024 ** 3;

describe('storageQuotaViolation (quota storageGb, docs/13 D6)', () => {
  it('n’impose rien sans limite (plan illimité ou établissement sans abonnement)', () => {
    expect(storageQuotaViolation(null, 999 * GB, GB)).toBeNull();
  });

  it('accepte un dépôt qui atteint exactement la limite', () => {
    expect(storageQuotaViolation(5, 4 * GB, GB)).toBeNull();
  });

  it('refuse un dépôt qui dépasserait la limite, avec la limite (Go) et l’usage courant (Go, 2 décimales)', () => {
    expect(storageQuotaViolation(5, 4.5 * GB, GB)).toEqual({ limit: 5, current: 4.5 });
    expect(storageQuotaViolation(1, GB - 1, 2)).toEqual({ limit: 1, current: 1 });
  });

  it('refuse tout dépôt avec une limite nulle', () => {
    expect(storageQuotaViolation(0, 0, 1)).toEqual({ limit: 0, current: 0 });
  });
});
