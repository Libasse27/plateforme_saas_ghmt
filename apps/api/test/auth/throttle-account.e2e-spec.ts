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

  it('ralentit login par tenantSlug|email même quand chaque requête vient d’une IP différente (délai progressif)', async () => {
    for (let i = 0; i < 5; i += 1) await loginFrom('compte-vise', 'victime@test.sn').expect(401);

    const delayed = await loginFrom('compte-vise', 'victime@test.sn').expect(429);

    expect(delayed.body.code).toBe('login_delayed');
  });

  it('ne pénalise pas un autre compte depuis d’autres adresses', async () => {
    await loginFrom('compte-vise', 'autre@test.sn').expect(401);
    await loginFrom('autre-etablissement', 'victime@test.sn').expect(401);
  });

  it('limite mot de passe oublié par tenantSlug|email (3 par 15 minutes) depuis des IP différentes', async () => {
    const forgot = (email: string) =>
      http(app).post(`${AUTH}/password/forgot`).set('X-Forwarded-For', distinctClientIp()).send({ tenantSlug: 'compte-oublie', email });
    for (let i = 0; i < 3; i += 1) await forgot('Cible@Test.sn').expect(202);

    const blocked = await forgot(' cible@test.sn '.trim().toUpperCase()).expect(429);

    expect(blocked.body.code).toBe('rate_limited');
    await forgot('autre@test.sn').expect(202);
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
