import { generate } from 'otplib';
import { describe, expect, it } from 'vitest';
import { TotpService } from './totp.service';

const STEP_SECONDS = 30;
const T0 = 1_800_000_000; // instant simulé (secondes)
const service = new TotpService();

async function codeAt(secret: string, epoch: number): Promise<string> {
  return generate({ secret, epoch });
}

describe('TotpService', () => {
  const secret = service.generateSecret();

  it('génère un secret base32 et une URL otpauth portant émetteur et libellé', () => {
    const url = service.buildUri(secret, 'ada@exemple.test');

    expect(secret).toMatch(/^[A-Z2-7]+$/);
    expect(url).toMatch(/^otpauth:\/\/totp\/GHMT:ada%40exemple\.test\?/);
    expect(url).toContain(`secret=${secret}`);
    expect(url).toContain('issuer=GHMT');
  });

  it('accepte le code du pas courant et renvoie son numéro de pas', async () => {
    const result = await service.verify(secret, await codeAt(secret, T0), { nowMs: T0 * 1000 });

    expect(result).toEqual({ valid: true, step: Math.floor(T0 / STEP_SECONDS) });
  });

  it('accepte le pas précédent et le pas suivant (fenêtre ±1)', async () => {
    const previous = await service.verify(secret, await codeAt(secret, T0 - STEP_SECONDS), { nowMs: T0 * 1000 });
    const next = await service.verify(secret, await codeAt(secret, T0 + STEP_SECONDS), { nowMs: T0 * 1000 });

    expect(previous.valid).toBe(true);
    expect(next.valid).toBe(true);
  });

  it('refuse un code distant de deux pas', async () => {
    const result = await service.verify(secret, await codeAt(secret, T0 + 2 * STEP_SECONDS), { nowMs: T0 * 1000 });

    expect(result.valid).toBe(false);
  });

  it('refuse le rejeu d’un pas déjà utilisé et accepte un pas postérieur', async () => {
    const code = await codeAt(secret, T0);
    const first = await service.verify(secret, code, { nowMs: T0 * 1000 });
    const lastUsedStep = first.valid ? first.step : undefined;

    const replay = await service.verify(secret, code, { nowMs: T0 * 1000, lastUsedStep });
    const later = await service.verify(secret, await codeAt(secret, T0 + STEP_SECONDS), { nowMs: T0 * 1000, lastUsedStep });

    expect(replay.valid).toBe(false);
    expect(later.valid).toBe(true);
  });

  it('refuse un code faux ou mal formé sans lever d’exception', async () => {
    expect((await service.verify(secret, '000000', { nowMs: T0 * 1000 })).valid).toBe(
      (await codeAt(secret, T0)) === '000000' ? true : false,
    );
    expect((await service.verify(secret, 'abc', { nowMs: T0 * 1000 })).valid).toBe(false);
    expect((await service.verify('!!pas-base32!!', '123456', { nowMs: T0 * 1000 })).valid).toBe(false);
  });
});
