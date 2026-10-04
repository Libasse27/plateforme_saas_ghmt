import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_PASSWORD, createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { AUTH, bearer, http, postLogin } from './auth-helpers';

const SPOOFED_IP = '203.0.113.77';

describe('auth : proxys de confiance et X-Forwarded-For (C9)', () => {
  let trusting: INestApplication;
  let untrusting: INestApplication;
  let tenant: TenantFixture;
  let user: UserFixture;

  beforeAll(async () => {
    trusting = await createTestApp();
    // Aucun proxy de confiance ne correspond à l'adresse de bouclage des tests.
    untrusting = await createTestApp({ TRUSTED_PROXIES: ['10.255.255.1'] });
    tenant = await createTenantFixture(trusting, { prefix: 'xff' });
    user = await createUserWithRole(trusting, tenant, 'receptionist');
  });

  afterAll(async () => {
    await Promise.all([trusting?.close(), untrusting?.close()]);
  });

  async function sessionIp(app: INestApplication, forwardedFor: string): Promise<string> {
    const res = await http(app)
      .post(`${AUTH}/login`)
      .set('X-Forwarded-For', forwardedFor)
      .send({ tenantSlug: tenant.slug, email: user.email, password: FIXTURE_PASSWORD })
      .expect(200);
    const sessions = await http(app).get(`${AUTH}/sessions`).set(bearer(res.body.data.accessToken)).expect(200);
    return (sessions.body.data as { current: boolean; ip: string }[]).find((s) => s.current)!.ip;
  }

  it('honore X-Forwarded-For quand la source est un proxy de confiance (loopback par défaut)', async () => {
    expect(await sessionIp(trusting, SPOOFED_IP)).toBe(SPOOFED_IP);
  });

  it('ignore X-Forwarded-For quand la source n’est pas un proxy de confiance', async () => {
    const ip = await sessionIp(untrusting, SPOOFED_IP);

    expect(ip).not.toBe(SPOOFED_IP);
    expect(ip).toMatch(/127\.0\.0\.1$|::1$/);
  });

  it('ne permet pas de contourner la limite par IP en falsifiant X-Forwarded-For', async () => {
    const attempt = (xff: string) => http(untrusting).post(`${AUTH}/signup`).set('X-Forwarded-For', xff).send({});
    for (let i = 0; i < 5; i += 1) await attempt(`198.51.100.${i + 1}`).expect(422);

    await attempt('198.51.100.200').expect(429);
  });

  it('autorise une liste de CIDR via TRUSTED_PROXIES', async () => {
    const cidr = await createTestApp({ TRUSTED_PROXIES: ['127.0.0.0/8', '::1'] });
    try {
      const res = await postLogin(cidr, tenant.slug, user.email).set('X-Forwarded-For', SPOOFED_IP).expect(200);
      const sessions = await http(cidr).get(`${AUTH}/sessions`).set(bearer(res.body.data.accessToken)).expect(200);
      expect((sessions.body.data as { current: boolean; ip: string }[]).find((s) => s.current)!.ip).toBe(SPOOFED_IP);
    } finally {
      await cidr.close();
    }
  });
});
