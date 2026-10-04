import { describe, expect, it, vi } from 'vitest';
import { signupInput } from '../../../../test/helpers/fixtures';
import { DomainError } from '../../../common/errors/domain-error';
import { SignupService } from './signup.service';

function build(options: { existing?: boolean; provision?: () => Promise<unknown> }) {
  const tenantDb = { runWithoutTenant: vi.fn().mockResolvedValue(options.existing ? [{ id: 'x' }] : []) };
  const passwords = { hash: vi.fn().mockResolvedValue('hash') };
  const provisioning = { provision: vi.fn(options.provision ?? (() => Promise.resolve({ tenantId: 'tid' }))) };
  const service = new SignupService(tenantDb as never, passwords as never, provisioning as never);
  return { service, passwords, provisioning };
}

describe('SignupService', () => {
  const input = signupInput('clinique-test');

  it('provisionne avec le mot de passe haché et renvoie tenantId et slug', async () => {
    const { service, provisioning } = build({});

    const result = await service.signup(input);

    expect(result).toEqual({ tenantId: 'tid', slug: 'clinique-test' });
    expect(provisioning.provision).toHaveBeenCalledWith(input, 'hash');
  });

  it('refuse sans hacher ni provisionner quand le slug existe déjà (409)', async () => {
    const { service, passwords, provisioning } = build({ existing: true });

    await expect(service.signup(input)).rejects.toMatchObject({ status: 409, code: 'slug_taken' });
    expect(passwords.hash).not.toHaveBeenCalled();
    expect(provisioning.provision).not.toHaveBeenCalled();
  });

  it.each([
    ['code Prisma P2002', { code: 'P2002' }],
    ['code PostgreSQL 23505 de l’adaptateur', { meta: { driverAdapterError: { cause: { originalCode: '23505' } } } }],
  ])('convertit une violation d’unicité concurrente en 409 (%s)', async (_label, error) => {
    const { service } = build({ provision: () => Promise.reject(error) });

    await expect(service.signup(input)).rejects.toBeInstanceOf(DomainError);
    await expect(service.signup(input)).rejects.toMatchObject({ status: 409 });
  });

  it('propage les autres erreurs telles quelles', async () => {
    const boom = new Error('panne');
    const { service } = build({ provision: () => Promise.reject(boom) });

    await expect(service.signup(input)).rejects.toBe(boom);
  });
});
