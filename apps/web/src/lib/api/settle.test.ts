import { describe, expect, it } from 'vitest';
import { ApiError } from './errors';
import { settle } from './settle';

describe('settle', () => {
  it('renvoie la valeur chargée', async () => {
    expect(await settle(async () => 42)).toEqual({ ok: true, value: 42 });
  });
  it('convertit une erreur API en message français avec son statut', async () => {
    const result = await settle(async () => {
      throw new ApiError({ status: 403, code: 'permission_denied' });
    });
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(result.ok === false && result.message).toContain('autorisation');
  });
  it('relance les erreurs inattendues', async () => {
    await expect(
      settle(async () => {
        throw new Error('bug');
      }),
    ).rejects.toThrow('bug');
  });
});
