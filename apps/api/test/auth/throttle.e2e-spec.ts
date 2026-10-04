import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../helpers/test-app';
import { AUTH, http } from './auth-helpers';

describe('auth : limitation de débit par IP', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('limite signup à 5 requêtes par heure et par IP (429 à la 6e)', async () => {
    for (let i = 0; i < 5; i += 1) {
      await http(app).post(`${AUTH}/signup`).send({}).expect(422);
    }

    const res = await http(app).post(`${AUTH}/signup`).send({}).expect(429);

    expect(res.body.code).toBe('rate_limited');
  });

  it('limite login à 20 requêtes par 15 minutes et par IP (429 à la 21e)', async () => {
    const body = { tenantSlug: 'inconnu-xyz', email: 'a@b.test', password: 'x' };
    for (let i = 0; i < 20; i += 1) {
      await http(app).post(`${AUTH}/login`).send(body).expect(401);
    }

    await http(app).post(`${AUTH}/login`).send(body).expect(429);
  });
});
