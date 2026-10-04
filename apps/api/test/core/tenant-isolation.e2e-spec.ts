import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyChain } from '../../src/common/audit/audit-chain';
import { auditPayload } from '../../src/common/audit/audit.service';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createTenantFixture, signupInput, type TenantFixture } from '../helpers/fixtures';
import { TenantProvisioningService } from '../../src/infrastructure/tenancy/tenant-provisioning.service';
import { createTestApp } from '../helpers/test-app';

describe('noyau : isolation multi-tenant, authentification, audit', () => {
  let app: INestApplication;
  let tenantDb: TenantDb;
  let a: TenantFixture;
  let b: TenantFixture;

  beforeAll(async () => {
    app = await createTestApp();
    tenantDb = app.get(TenantDb);
    [a, b] = await Promise.all([createTenantFixture(app, { prefix: 'iso-a' }), createTenantFixture(app, { prefix: 'iso-b' })]);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /health est public et enveloppé', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/health').expect(200);
    expect(res.body).toMatchObject({ success: true, data: { status: 'ok' }, error: null });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('provisionne 13 rôles système, un site principal et un admin', async () => {
    const counts = await tenantDb.runAs(a.tenantId, async (tx) => ({
      roles: await tx.role.count({ where: { isSystem: true } }),
      sites: await tx.site.count(),
      users: await tx.user.count(),
    }));
    expect(counts).toEqual({ roles: 13, sites: 1, users: 1 });
  });

  it('un tenant ne voit jamais les données d’un autre (RLS)', async () => {
    const seenFromB = await tenantDb.runAs(b.tenantId, (tx) =>
      tx.user.findMany({ where: { id: a.adminUserId }, select: { id: true } }),
    );
    expect(seenFromB).toEqual([]);
    const sitesFromB = await tenantDb.runAs(b.tenantId, (tx) => tx.site.findMany({ select: { tenantId: true } }));
    expect(sitesFromB.every((s) => s.tenantId === b.tenantId)).toBe(true);
  });

  it('refuse d’écrire une ligne pour un autre tenant (WITH CHECK)', async () => {
    await expect(
      tenantDb.runAs(b.tenantId, (tx) => tx.site.create({ data: { tenantId: a.tenantId, code: 'PIRATE', name: 'Intrusion' } })),
    ).rejects.toThrow();
  });

  it('sans contexte tenant, aucune ligne n’est visible', async () => {
    const rows = await tenantDb.runWithoutTenant((tx) => tx.user.findMany({ select: { id: true } }));
    expect(rows).toEqual([]);
  });

  it('rejette une requête protégée sans jeton (401 problem+json)', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.body).toMatchObject({ success: false, status: 401, code: 'unauthenticated' });
  });

  it('rejette un jeton falsifié', async () => {
    const forged = `${a.adminToken.slice(0, -4)}abcd`;
    await request(app.getHttpServer()).get('/api/v1/auth/me').set('Authorization', `Bearer ${forged}`).expect(401);
  });

  it('le journal d’audit est chaîné et append-only', async () => {
    const rows = await tenantDb.runAs(a.tenantId, (tx) => tx.auditLog.findMany({ orderBy: { chainSeq: 'asc' } }));
    expect(rows.length).toBeGreaterThan(0);
    const records = rows.map((r) => ({
      chainSeq: r.chainSeq,
      prevHash: r.prevHash,
      hash: r.hash,
      payload: auditPayload({ ...r, changes: r.changes ?? null }),
    }));
    expect(verifyChain(records)).toBe(true);

    await expect(
      tenantDb.runAs(a.tenantId, (tx) => tx.auditLog.updateMany({ data: { action: 'effacé' } })),
    ).rejects.toThrow();
  });

  it('refuse de provisionner un slug déjà utilisé (contrainte d’unicité, aucune donnée partielle)', async () => {
    const provisioning = app.get(TenantProvisioningService);
    await expect(provisioning.provision(signupInput(a.slug), 'hash-inutilise')).rejects.toThrow();
    const users = await tenantDb.runAs(a.tenantId, (tx) => tx.user.count());
    expect(users).toBe(1);
  });
});
