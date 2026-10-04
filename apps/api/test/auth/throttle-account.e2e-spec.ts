import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACCOUNT_THROTTLE_LIMIT } from '../../src/common/throttle/account-throttle';
import { createTestApp } from '../helpers/test-app';
import { AUTH, distinctClientIp, http } from './auth-helpers';

describe('auth : limitation de débit par compte (H1)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  const loginFrom = (slug: string, email: string) =>
    http(app).post(`${AUTH}/login`).set('X-Forwarded-For', distinctClientIp()).send({ tenantSlug: slug, email, password: 'x' });

  it('limite login par tenantSlug|email même quand chaque requête vient d’une IP différente', async () => {
    for (let i = 0; i < ACCOUNT_THROTTLE_LIMIT; i += 1) await loginFrom('compte-vise', 'victime@test.sn').expect(401);

    const blocked = await loginFrom('compte-vise', 'victime@test.sn').expect(429);

    expect(blocked.body.code).toBe('rate_limited');
  });

  it('ne pénalise pas un autre compte depuis d’autres adresses', async () => {
    await loginFrom('compte-vise', 'autre@test.sn').expect(401);
    await loginFrom('autre-etablissement', 'victime@test.sn').expect(401);
  });

  it('normalise la casse et les espaces de l’e-mail (pas de contournement par variantes)', async () => {
    for (let i = 0; i < ACCOUNT_THROTTLE_LIMIT; i += 1) await loginFrom('compte-casse', 'Cible@Test.sn').expect(401);

    await loginFrom('COMPTE-CASSE', ' cible@test.sn ').expect(429);
  });

  it('limite mfa/verify par défi, indépendamment de l’IP', async () => {
    const challengeId = `${'0198a000-0000-7000-8000-000000000001'}.${'a'.repeat(43)}`;
    const verify = () => http(app).post(`${AUTH}/mfa/verify`).set('X-Forwarded-For', distinctClientIp()).send({ challengeId, code: '123456' });
    for (let i = 0; i < ACCOUNT_THROTTLE_LIMIT; i += 1) await verify().expect(401);

    await verify().expect(429);
    await http(app)
      .post(`${AUTH}/mfa/verify`)
      .set('X-Forwarded-For', distinctClientIp())
      .send({ challengeId: `${'0198a000-0000-7000-8000-000000000001'}.${'b'.repeat(43)}`, code: '123456' })
      .expect(401);
  });

  it('se replie sur l’IP quand le corps est inexploitable (pas de seau global pour les corps invalides)', async () => {
    for (let i = 0; i < ACCOUNT_THROTTLE_LIMIT + 2; i += 1) {
      await http(app).post(`${AUTH}/login`).set('X-Forwarded-For', distinctClientIp()).send({ tenantSlug: 12 }).expect(422);
    }
  });
});
