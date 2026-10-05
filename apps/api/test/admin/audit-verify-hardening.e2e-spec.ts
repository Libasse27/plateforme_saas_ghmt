import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AuditChainVerificationService } from '../../src/modules/admin/services/audit-chain-verification.service';
import { createTenantFixture, type TenantFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { AUDIT_LOGS } from './admin-fixtures';

const VERIFY = `${AUDIT_LOGS}/verify`;

describe('GET /audit-logs/verify : durcissement (revue sécurité)', () => {
  let app: INestApplication;
  let tenant: TenantFixture;

  beforeAll(async () => {
    app = await createTestApp();
    tenant = await createTenantFixture(app, { prefix: 'ver-harden' });
  });

  afterAll(async () => {
    await app?.close();
  });

  const call = (ip: string) => request(app.getHttpServer()).get(VERIFY).set('Authorization', `Bearer ${tenant.adminToken}`).set('X-Forwarded-For', ip);

  it('limite par utilisateur (3 par minute) même en changeant d’adresse IP', async () => {
    for (const ip of ['10.9.0.1', '10.9.0.2', '10.9.0.3']) await call(ip).expect(200);

    await call('10.9.0.4').expect(429);
  });

  it('refuse une seconde vérification concurrente du même établissement', async () => {
    const other = await createTenantFixture(app, { prefix: 'ver-harden2' });
    const service = app.get(AuditChainVerificationService);
    const original = service.verify.bind(service);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(service, 'verify').mockImplementationOnce(async (query) => {
      await gate;
      return original(query);
    });
    const send = (ip: string) => request(app.getHttpServer()).get(VERIFY).set('Authorization', `Bearer ${other.adminToken}`).set('X-Forwarded-For', ip);

    const first = send('10.9.1.1').then((res) => res.status);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const second = await send('10.9.1.2');
    release();

    expect(second.status).toBe(429);
    expect(second.body.code).toBe('verification_in_progress');
    expect(await first).toBe(200);
  });
});
