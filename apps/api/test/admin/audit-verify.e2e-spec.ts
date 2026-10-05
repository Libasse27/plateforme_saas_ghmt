import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { AUDIT_LOGS, auditRows, bearer, http, seedAudit } from './admin-fixtures';

const VERIFY = `${AUDIT_LOGS}/verify`;

describe('GET /audit-logs/verify : lecture (HTTP)', () => {
  let app: INestApplication;
  let a: TenantFixture;
  let b: TenantFixture;
  let director: UserFixture;

  beforeAll(async () => {
    app = await createTestApp();
    [a, b] = await Promise.all([createTenantFixture(app, { prefix: 'ver-a' }), createTenantFixture(app, { prefix: 'ver-b' })]);
    director = await createUserWithRole(app, a, 'director');
    await seedAudit(app, a, [{ action: 'seed.verify', changes: { n: 1 } }, { action: 'seed.verify', changes: { n: 2 } }]);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('déclare la chaîne intacte et renvoie la fenêtre vérifiée (directeur autorisé)', async () => {
    const res = await http(app).get(VERIFY).set(bearer(director)).expect(200);

    const total = await auditRows(app, a, 'seed.verify');
    expect(total).toHaveLength(2);
    expect(res.body.data).toMatchObject({ status: 'intact', fromSeq: '1', firstBrokenSeq: null, checkedAt: expect.stringMatching(/Z$/) });
    expect(Number(res.body.data.checkedCount)).toBeGreaterThanOrEqual(2);
    expect(res.body.data.toSeq).toBe(String(res.body.data.checkedCount));
  });

  it('borne la fenêtre vérifiée à la limite demandée (les maillons les plus récents)', async () => {
    const res = await http(app).get(VERIFY).query({ limit: 1000 }).set(bearer({ token: a.adminToken })).expect(200);

    expect(res.body.data.status).toBe('intact');
    expect(res.body.data.checkedCount).toBeLessThanOrEqual(1000);
  });

  it('trace audit.chain_verified avec le résultat', async () => {
    const rows = await auditRows(app, a, 'audit.chain_verified');

    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]!.changes).toMatchObject({ status: 'intact', firstBrokenSeq: null });
    expect(rows[0]!.actorUserId).toBeDefined();
  });

  it('ne vérifie que la chaîne de son propre établissement', async () => {
    const res = await http(app).get(VERIFY).set(bearer({ token: b.adminToken })).expect(200);

    const own = await auditRows(app, b, 'audit.chain_verified');
    expect(res.body.data.status).toBe('intact');
    expect(res.body.data.fromSeq).toBe('1');
    expect(own).toHaveLength(1);
  });
});

describe('GET /audit-logs/verify : refus et validation (HTTP)', () => {
  let app: INestApplication;
  let a: TenantFixture;
  let doctor: UserFixture;

  beforeAll(async () => {
    app = await createTestApp();
    a = await createTenantFixture(app, { prefix: 'ver-deny' });
    doctor = await createUserWithRole(app, a, 'doctor');
  });

  afterAll(async () => {
    await app?.close();
  });

  it('refuse un médecin (403)', async () => {
    await http(app).get(VERIFY).set(bearer(doctor)).expect(403);
  });

  it.each([{ limit: 999 }, { limit: 50001 }])('rejette %j avec 422', async (query) => {
    await http(app).get(VERIFY).query(query).set(bearer({ token: a.adminToken })).expect(422);
  });
});

describe('GET /audit-logs/verify : limitation de débit (HTTP)', () => {
  it('répond 429 à la 4e demande par minute pour une même IP', async () => {
    const app = await createTestApp();
    try {
      const tenant = await createTenantFixture(app, { prefix: 'ver-rate' });
      for (let i = 0; i < 3; i += 1) await http(app).get(VERIFY).set(bearer({ token: tenant.adminToken })).expect(200);

      await http(app).get(VERIFY).set(bearer({ token: tenant.adminToken })).expect(429);
    } finally {
      await app.close();
    }
  });
});
