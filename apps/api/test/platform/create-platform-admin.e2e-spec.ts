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
  assertSecretsCanBeShown,
  createPlatformAdmin,
  formatEnrollment,
  generatePassword,
  runCli,
  validateParams,
} from '../../scripts/create-platform-admin.mts';
import { FieldCrypto } from '../../src/common/crypto/field-crypto.service';
import { PLATFORM_CRYPTO_SCOPE } from '../../src/modules/platform/platform.constants';
import { hashBackupCode } from '../../src/modules/auth/services/backup-codes';
import { totpNow } from '../helpers/platform';
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

  it('crée l’utilisateur (Argon2id, audité) avec son TOTP déjà enrôlé : secret chiffré lisible par l’API et connexion par challenge', async () => {
    const email = uniqueEmail();

    const { id, enrollment } = await createPlatformAdmin(client, { email, fullName: 'Premier Admin', role: 'super_admin', password: STRONG_PASSWORD });

    const row = await app.get(PlatformDb).run((tx) => tx.platformUser.findUniqueOrThrow({ where: { id } }));
    expect(row).toMatchObject({ email: email.toLowerCase(), role: 'super_admin', status: 'active', failedAttempts: 0 });
    expect(row.mfaActivatedAt).not.toBeNull();
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row.passwordHash).not.toContain(STRONG_PASSWORD);
    expect(app.get(FieldCrypto).decrypt(PLATFORM_CRYPTO_SCOPE, row.mfaSecretEnc!)).toBe(enrollment.totpSecret);
    expect(enrollment.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(enrollment.backupCodes).toHaveLength(10);
    expect(row.mfaBackupHashes).toEqual(enrollment.backupCodes.map((code) => hashBackupCode(id, code)));
    const audit = await app.get(PlatformDb).run((tx) => tx.platformAuditLog.findMany({ where: { action: 'platform.user_created', resourceId: id } }));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.changes)).not.toContain(STRONG_PASSWORD);
    expect(JSON.stringify(audit[0]!.changes)).not.toContain(enrollment.totpSecret);

    const login = await http(app).post(`${PLATFORM}/auth/login`).set('X-Forwarded-For', platformClientIp()).send({ email: email.toLowerCase(), password: STRONG_PASSWORD }).expect(200);
    expect(login.body.data).toMatchObject({ mfaRequired: true });
    const verified = await http(app)
      .post(`${PLATFORM}/auth/mfa/verify`)
      .set('X-Forwarded-For', platformClientIp())
      .send({ challengeId: login.body.data.challengeId, code: await totpNow(enrollment.totpSecret) })
      .expect(200);
    expect(verified.body.data.mfaEnrolled).toBe(true);
  });

  it('les codes de secours générés par le script ouvrent une session (une seule fois)', async () => {
    const email = uniqueEmail();
    const { enrollment } = await createPlatformAdmin(client, { email, fullName: 'Admin Secours', role: 'support', password: STRONG_PASSWORD });
    const challenge = async () =>
      (await http(app).post(`${PLATFORM}/auth/login`).set('X-Forwarded-For', platformClientIp()).send({ email: email.toLowerCase(), password: STRONG_PASSWORD }).expect(200)).body.data
        .challengeId as string;
    const verify = (challengeId: string) =>
      http(app).post(`${PLATFORM}/auth/mfa/verify`).set('X-Forwarded-For', platformClientIp()).send({ challengeId, code: enrollment.backupCodes[0] });

    await verify(await challenge()).expect(200);
    await verify(await challenge()).expect(401);
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

  describe('secrets affichés uniquement sur un terminal (M2)', () => {
    const io = (isTTY: boolean, env: Record<string, string> = {}) => {
      const out: string[] = [];
      return {
        out,
        io: { stdout: { isTTY, write: (text: string) => out.push(text) }, stdin: { isTTY: false }, env: { ...process.env, ...env } as NodeJS.ProcessEnv },
      };
    };

    it('affiche l’URI otpauth, les codes de secours et le mot de passe généré sur un terminal, et la connexion fonctionne', async () => {
      const email = uniqueEmail();
      const sink = io(true);

      await runCli(['--email', email, '--name', 'Admin CLI', '--role', 'support', '--generate'], sink.io);

      const text = sink.out.join('');
      expect(text).toContain('Utilisateur plateforme créé');
      expect(text).toMatch(/otpauth:\/\/totp\//);
      const password = /Mot de passe généré[^:]*: (\S+)/.exec(text)?.[1];
      expect(password!.length).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
      await http(app).post(`${PLATFORM}/auth/login`).set('X-Forwarded-For', platformClientIp()).send({ email: email.toLowerCase(), password }).expect(200);
    });

    it('lit le mot de passe dans PLATFORM_ADMIN_PASSWORD sans jamais l’afficher', async () => {
      const sink = io(true, { PLATFORM_ADMIN_PASSWORD: STRONG_PASSWORD });

      await runCli(['--email', uniqueEmail(), '--name', 'Admin Env'], sink.io);

      expect(sink.out.join('')).toContain('Utilisateur plateforme créé');
      expect(sink.out.join('')).not.toContain(STRONG_PASSWORD);
    });

    it('refuse AVANT toute création quand la sortie est redirigée (aucun secret écrit, aucun compte)', async () => {
      const email = uniqueEmail();
      const sink = io(false);

      await expect(runCli(['--email', email, '--name', 'Admin Pipe', '--generate'], sink.io)).rejects.toThrow(/redirigée/);

      expect(sink.out).toEqual([]);
      expect(await app.get(PlatformDb).run((tx) => tx.platformUser.count({ where: { email: email.toLowerCase() } }))).toBe(0);
      expect(() => assertSecretsCanBeShown({ isTTY: true })).not.toThrow();
      expect(formatEnrollment({ totpSecret: 's', otpauthUrl: 'otpauth://totp/x', backupCodes: ['AAAAAAAAAA'] })).toContain('AAAAAAAAAA');
    });
  });

  describe('exécution en ligne de commande (processus réel, sortie non interactive)', () => {
    const script = resolve(API_ROOT, 'scripts/create-platform-admin.mts');
    const cli = (args: string[], env: Record<string, string> = {}) =>
      run(process.execPath, [script, ...args], { cwd: API_ROOT, env: { ...process.env, ...env } });

    it('refuse de s’exécuter avec stdout redirigé : rien sur stdout, message clair sur stderr, aucun compte créé', async () => {
      const email = uniqueEmail();

      await expect(cli(['--email', email, '--name', 'Admin CLI', '--generate'])).rejects.toMatchObject({
        code: 1,
        stdout: '',
        stderr: expect.stringContaining('redirigée'),
      });

      expect(await app.get(PlatformDb).run((tx) => tx.platformUser.count({ where: { email: email.toLowerCase() } }))).toBe(0);
    });

    it('échoue avec un message clair et un code de sortie non nul si les arguments manquent', async () => {
      await expect(cli(['--generate'])).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Usage') });
    });
  });
});
