import { describe, expect, it } from 'vitest';
import { DomainError } from './domain-error';

describe('DomainError.loginDelayed', () => {
  it('produit un 429 login_delayed portant le délai dans extras et dans details', () => {
    const error = DomainError.loginDelayed(30);
    expect(error).toMatchObject({ code: 'login_delayed', status: 429 });
    expect(error.detail).toBe('Trop de tentatives pour ce compte. Réessayez dans 30 secondes.');
    expect(error.extras.retryAfterSeconds).toBe(30);
    expect(error.extras.details).toEqual({ retryAfterSeconds: 30 });
  });
});
