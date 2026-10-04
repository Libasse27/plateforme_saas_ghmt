import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { INestApplication } from '@nestjs/common';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CliError,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  createPlatformAdmin,
  generatePassword,
  validateParams,
} from '../../scripts/create-platform-admin.mts';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { PLATFORM, http, platformClientIp } from '../helpers/platform';
import { createTestApp } from '../helpers/test-app';

const run = promisify(execFile);
const API_ROOT = resolve(__dirname, '../..');
const STRONG_PASSWORD = 'Un-mot-de-passe-solide-2026';
let counter = 0;
const uniqueEmail = (): string => `Admin${(counter += 1)}-${Math.random().toString(36).slice(2, 8)}@Plateforme.test`;

describe('platform : script create-platform-admin.mts', () => {
  let app: INestApplication;
  let client: pg.Client;

  beforeAll(async () => {
    app = await createTestApp();
    client = new pg.Client({ connectionString: process.env['PLATFORM_DATABASE_URL'] });
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
    await app?.close();
  });

  describe('validation des entrées', () => {
    const valid = { email: 'ops@ghmt.test', fullName: 'Awa Diop', role: 'super_admin', password: STRONG_PASSWORD } as const;

    it('normalise l’e-mail (minuscules, espaces) et le nom', () => {
      expect(validateParams({ ...valid, email: '  OPS@GHMT.test ', fullName: '  Awa Diop ' })).toMatchObject({ email: 'ops@ghmt.test', fullName: 'Awa Diop' });
    });

    it.each([
      ['e-mail invalide', { email: 'pas-un-email' }, /e-mail/],
      ['nom trop court', { fullName: 'A' }, /nom complet/],
      ['rôle inconnu', { role: 'root' as never }, /Rôle invalide/],
      ['mot de passe trop court', { password: 'x'.repeat(MIN_PASSWORD_LENGTH - 1) }, /mot de passe/],
      ['mot de passe trop long', { password: 'x'.repeat(MAX_PASSWORD_LENGTH + 1) }, /mot de passe/],
    ])('rejette : %s', (_label, patch, message) => {
      expect(() => validateParams({ ...valid, ...patch })).toThrow(CliError);
      expect(() => validateParams({ ...valid, ...patch })).toThrow(message);
    });
  });

  it('génère des mots de passe aléatoires conformes à la politique', () => {
    const first = generatePassword();
    expect(first.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
    expect(first).not.toBe(generatePassword());
  });

  it('crée l’utilisateur (Argon2id, sans MFA, audité) puis permet la première connexion avec enrôlement TOTP imposé', async () => {
    const email = uniqueEmail();

    const { id } = await createPlatformAdmin(client, { email, fullName: 'Premier Admin', role: 'super_admin', password: STRONG_PASSWORD });

    const row = await app.get(PlatformDb).run((tx) => tx.platformUser.findUniqueOrThrow({ where: { id } }));
    expect(row).toMatchObject({ email: email.toLowerCase(), role: 'super_admin', status: 'active', mfaActivatedAt: null, failedAttempts: 0 });
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row.passwordHash).not.toContain(STRONG_PASSWORD);
    const audit = await app.get(PlatformDb).run((tx) => tx.platformAuditLog.findMany({ where: { action: 'platform.user_created', resourceId: id } }));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.changes)).not.toContain(STRONG_PASSWORD);

    const login = await http(app)
      .post(`${PLATFORM}/auth/login`)
      .set('X-Forwarded-For', platformClientIp())
      .send({ email: email.toLowerCase(), password: STRONG_PASSWORD })
      .expect(200);
    expect(login.body.data).toMatchObject({ mfaEnrolled: false, mfaRequired: true });
  });

  it('refuse un e-mail déjà utilisé (insensible à la casse) sans rien créer', async () => {
    const email = uniqueEmail();
    await createPlatformAdmin(client, { email, fullName: 'Premier Admin', role: 'billing', password: STRONG_PASSWORD });

    await expect(
      createPlatformAdmin(client, { email: email.toUpperCase(), fullName: 'Doublon', role: 'support', password: STRONG_PASSWORD }),
    ).rejects.toThrow(/existe déjà/);

    const count = await app.get(PlatformDb).run((tx) => tx.platformUser.count({ where: { email: email.toLowerCase() } }));
    expect(count).toBe(1);
  });

  it('accepte les trois rôles de la matrice plateforme', async () => {
    for (const role of ['super_admin', 'support', 'billing'] as const) {
      const { id } = await createPlatformAdmin(client, { email: uniqueEmail(), fullName: `Role ${role}`, role, password: STRONG_PASSWORD });
      const row = await app.get(PlatformDb).run((tx) => tx.platformUser.findUniqueOrThrow({ where: { id } }));
      expect(row.role).toBe(role);
    }
  });

  describe('exécution en ligne de commande', () => {
    const script = resolve(API_ROOT, 'scripts/create-platform-admin.mts');
    const cli = (args: string[], env: Record<string, string> = {}) =>
      run(process.execPath, [script, ...args], { cwd: API_ROOT, env: { ...process.env, ...env } });

    it('génère un mot de passe affiché une seule fois et crée le compte (--generate)', async () => {
      const email = uniqueEmail();

      const { stdout } = await cli(['--email', email, '--name', 'Admin CLI', '--role', 'support', '--generate']);

      expect(stdout).toContain('Utilisateur plateforme créé');
      const password = /Mot de passe généré[^:]*: (\S+)/.exec(stdout)?.[1];
      expect(password).toBeDefined();
      expect(password!.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
      await http(app)
        .post(`${PLATFORM}/auth/login`)
        .set('X-Forwarded-For', platformClientIp())
        .send({ email: email.toLowerCase(), password })
        .expect(200);
    });

    it('lit le mot de passe dans PLATFORM_ADMIN_PASSWORD sans jamais l’afficher', async () => {
      const { stdout } = await cli(['--email', uniqueEmail(), '--name', 'Admin Env'], { PLATFORM_ADMIN_PASSWORD: STRONG_PASSWORD });
      expect(stdout).toContain('Utilisateur plateforme créé');
      expect(stdout).not.toContain(STRONG_PASSWORD);
    });

    it('échoue avec un message clair et un code de sortie non nul si les arguments manquent ou sont invalides', async () => {
      await expect(cli(['--generate'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Usage') });
      await expect(cli(['--email', 'invalide', '--name', 'Admin', '--generate'])).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('e-mail invalide'),
      });
      await expect(cli(['--email', uniqueEmail(), '--name', 'Admin'], { PLATFORM_ADMIN_PASSWORD: 'court' })).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining('mot de passe'),
      });
    });
  });
});
