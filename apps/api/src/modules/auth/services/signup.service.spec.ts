import { describe, expect, it, vi } from 'vitest';
import { signupInput } from '../../../../test/helpers/fixtures';
import { MemoryMailer } from '../../../common/mail/memory-mailer';
import { DomainError } from '../../../common/errors/domain-error';
import { Clock } from '../../../common/time/clock';
import { SignupService } from './signup.service';

interface BuildOptions {
  readonly slugStatus?: 'available' | 'taken' | 'reserved';
  readonly provision?: (...args: unknown[]) => Promise<unknown>;
  readonly mailBlocked?: boolean;
}

const TENANT_ID = '0198a2b4-7c3d-7e11-8a52-3f6d2c9b1e04';
const ADMIN_ID = '0198a2b4-7c3d-7e11-8a52-3f6d2c9b1e05';

function build(options: BuildOptions = {}) {
  const tx = { signupVerification: { updateMany: vi.fn().mockResolvedValue({ count: 0 }), create: vi.fn().mockResolvedValue({}) } };
  const tenantDb = {
    runWithoutTenant: vi.fn().mockResolvedValue([{ status: options.slugStatus ?? 'available' }]),
    runAs: vi.fn((_tenantId: string, fn: (t: unknown) => Promise<unknown>) => fn(tx)),
  };
  const passwords = { hash: vi.fn().mockResolvedValue('hash') };
  const provision = vi.fn(
    options.provision ??
      (async (_input: unknown, _hash: unknown, _modules: unknown, provisionOptions: { afterProvision?: (t: unknown, p: unknown) => Promise<void> }) => {
        const provisioned = { tenantId: TENANT_ID, adminUserId: ADMIN_ID, mainSiteId: 's' };
        await provisionOptions.afterProvision?.(tx, provisioned);
        return provisioned;
      }),
  );
  const audit = { record: vi.fn().mockResolvedValue(undefined) };
  const mailer = new MemoryMailer();
  const clock = { now: () => new Date('2026-10-06T08:00:00Z') } as Clock;
  const env = { WEB_URL: 'http://localhost:3001' };
  const store = { hit: vi.fn().mockResolvedValue({ totalHits: 1, timeToExpireMs: 1, isBlocked: options.mailBlocked ?? false, timeToBlockExpireMs: 0 }) };
  const service = new SignupService(tenantDb as never, passwords as never, { provision } as never, audit as never, mailer, clock, env as never, store as never);
  return { service, passwords, provision, mailer, audit, tenantDb, tx, store };
}

describe('SignupService', () => {
  const input = signupInput('clinique-test');

  it('provisionne en statut pending avec le mot de passe haché et renvoie tenantId et slug', async () => {
    const { service, provision } = build();

    const result = await service.signup(input);

    expect(result).toEqual({ tenantId: TENANT_ID, slug: 'clinique-test' });
    expect(provision).toHaveBeenCalledWith(input, 'hash', undefined, expect.objectContaining({ initialStatus: 'pending' }));
  });

  it('crée le jeton de vérification dans la transaction de provisionnement (hash seul stocké)', async () => {
    const { service, tx } = build();

    await service.signup(input);

    expect(tx.signupVerification.create).toHaveBeenCalledTimes(1);
    const data = tx.signupVerification.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ tenantId: TENANT_ID, userId: ADMIN_ID });
    expect(data.expiresAt).toEqual(new Date('2026-10-07T08:00:00Z'));
    expect(data.tokenHash).toHaveLength(32);
  });

  it('envoie l’e-mail de vérification après la validation et audite l’envoi', async () => {
    const { service, mailer, audit } = build();

    await service.signup(input);

    const mail = mailer.lastTo(input.admin.email);
    expect(mail?.text).toMatch(/http:\/\/localhost:3001\/inscription\/confirmer\/0198a2b4-7c3d-7e11-8a52-3f6d2c9b1e04\.[A-Za-z0-9_-]{43}/);
    expect(mail?.text).toContain('clinique-test');
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      TENANT_ID,
      expect.objectContaining({ action: 'tenant.signup_verification_sent', actorUserId: ADMIN_ID, actorType: 'user' }),
    );
  });

  it('limite les e-mails par adresse de destination : au-delà, 201 sans envoi (clé hachée, jamais l’adresse)', async () => {
    const { service, mailer, store } = build({ mailBlocked: true });

    await expect(service.signup(input)).resolves.toEqual({ tenantId: TENANT_ID, slug: 'clinique-test' });

    expect(mailer.sent).toHaveLength(0);
    const key = store.hit.mock.calls[0]![0] as string;
    expect(key).toMatch(/^signup-mail:[0-9a-f]{64}$/);
    expect(key).not.toContain(input.admin.email);
  });

  it('envoie un e-mail au libellé fixe, sans le nom de l’établissement ni celui de la personne', async () => {
    const { service, mailer } = build();

    await service.signup(input);

    const mail = mailer.lastTo(input.admin.email)!;
    expect(mail.subject).toBe('Confirmez votre inscription à GHMT');
    expect(mail.text + (mail.html ?? '')).not.toContain(input.establishment.legalName);
    expect(mail.text + (mail.html ?? '')).not.toContain(input.admin.fullName);
  });

  it('répond 201 même si l’envoi SMTP échoue (renvoi possible), sans journaliser le jeton', async () => {
    const { service, mailer, audit } = build();
    mailer.failOnNextSend();

    await expect(service.signup(input)).resolves.toEqual({ tenantId: TENANT_ID, slug: 'clinique-test' });

    expect(mailer.sent).toHaveLength(0);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuse un identifiant réservé (422 slug_reserved sur establishment.slug) sans hacher ni provisionner', async () => {
    const { service, passwords, provision } = build({ slugStatus: 'reserved' });

    const error = await service.signup(signupInput('admin')).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ status: 422, code: 'slug_reserved', extras: { errors: [{ path: 'establishment.slug', code: 'slug_reserved' }] } });
    expect(passwords.hash).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });

  it('refuse sans hacher ni provisionner quand le slug existe déjà (409)', async () => {
    const { service, passwords, provision } = build({ slugStatus: 'taken' });

    await expect(service.signup(input)).rejects.toMatchObject({ status: 409, code: 'slug_taken' });
    expect(passwords.hash).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });

  it.each([
    ['code Prisma P2002', { code: 'P2002' }],
    ['code PostgreSQL 23505 de l’adaptateur', { meta: { driverAdapterError: { cause: { originalCode: '23505' } } } }],
  ])('convertit une violation d’unicité concurrente en 409 (%s)', async (_label, error) => {
    const { service } = build({ provision: () => Promise.reject(error) });

    await expect(service.signup(input)).rejects.toBeInstanceOf(DomainError);
    await expect(service.signup(input)).rejects.toMatchObject({ status: 409 });
  });

  it('convertit le refus « reserved slug » de la fonction SQL (course ou contournement) en 422', async () => {
    const error = { message: 'reserved slug', meta: { driverAdapterError: { cause: { originalCode: '22023', message: 'reserved slug' } } } };
    const { service } = build({ provision: () => Promise.reject(error) });

    await expect(service.signup(input)).rejects.toMatchObject({ status: 422, code: 'slug_reserved' });
  });

  it('propage les autres erreurs telles quelles', async () => {
    const boom = new Error('panne');
    const { service } = build({ provision: () => Promise.reject(boom) });

    await expect(service.signup(input)).rejects.toBe(boom);
  });
});
