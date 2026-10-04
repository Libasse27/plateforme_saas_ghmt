import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PlatformDb } from '../../src/infrastructure/prisma/platform-db.service';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createTenantFixture, createUserWithRole, type TenantFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { createPatientRow } from '../appointments/appointment-fixtures';

const TENANT_TABLES = ['patients', 'users', 'sites', 'appointments', 'sessions', 'audit_logs', 'roles'] as const;
const PLATFORM_ONLY_TABLES = [
  'plans',
  'subscriptions',
  'saas_invoices',
  'saas_invoice_lines',
  'saas_invoice_counters',
  'billing_entities',
  'manual_payments',
  'platform_users',
  'platform_sessions',
  'platform_refresh_tokens',
  'platform_mfa_challenges',
  'audit_logs',
] as const;

describe('platform : cloisonnement des rôles SQL (ghmt_platform / ghmt_app)', () => {
  let app: INestApplication;
  let a: TenantFixture;
  let b: TenantFixture;

  const asPlatform = <T>(sql: string): Promise<T> => app.get(PlatformDb).run((tx) => tx.$queryRawUnsafe<T>(sql));
  const asTenant = <T>(tenantId: string, sql: string): Promise<T> => app.get(TenantDb).runAs(tenantId, (tx) => tx.$queryRawUnsafe<T>(sql));

  beforeAll(async () => {
    app = await createTestApp();
    [a, b] = await Promise.all([createTenantFixture(app, { prefix: 'iso-a' }), createTenantFixture(app, { prefix: 'iso-b', subscriptionPlan: 'basic' })]);
    await createUserWithRole(app, a, 'receptionist');
    await createPatientRow(app, a);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('ghmt_platform n’accède jamais directement au schéma tenant', () => {
    it.each(TENANT_TABLES)('refuse SELECT sur tenant.%s (permission denied)', async (table) => {
      await expect(asPlatform(`SELECT 1 FROM tenant.${table} LIMIT 1`)).rejects.toThrow(/permission denied/i);
    });

    it('refuse aussi les écritures dans le schéma tenant (clauses WHERE false : aucune ligne ne peut être touchée)', async () => {
      await expect(asPlatform(`UPDATE tenant.users SET full_name = 'x' WHERE false`)).rejects.toThrow(/permission denied/i);
      await expect(asPlatform(`UPDATE tenant.patients SET last_name = 'x' WHERE false`)).rejects.toThrow(/permission denied/i);
    });
  });

  describe('agrégats d’usage : fonction SECURITY DEFINER, comptes uniquement', () => {
    it('renvoie exactement des colonnes de comptage (aucune donnée patient) pour les établissements demandés', async () => {
      const rows = await asPlatform<Record<string, unknown>[]>(
        `SELECT * FROM platform.tenants_usage(ARRAY['${a.tenantId}']::uuid[], now())`,
      );

      expect(rows).toHaveLength(1);
      expect(Object.keys(rows[0]!).sort()).toEqual(['appointments_30d', 'appointments_month', 'patients', 'sites', 'tenant_id', 'users']);
      expect(rows[0]).toMatchObject({ tenant_id: a.tenantId, users: 2, sites: 1, patients: 1 });
      for (const [key, value] of Object.entries(rows[0]!)) {
        if (key !== 'tenant_id') expect(typeof value).toBe('number');
      }
    });

    it('cloisonne les décomptes entre établissements et restaure le contexte tenant de la session', async () => {
      const result = await app.get(PlatformDb).run(async (tx) => {
        const rows = await tx.$queryRawUnsafe<{ tenant_id: string; users: number; patients: number }[]>(
          `SELECT tenant_id::text AS tenant_id, users, patients FROM platform.tenants_usage(ARRAY['${a.tenantId}','${b.tenantId}']::uuid[], now())`,
        );
        const [{ ctx }] = await tx.$queryRawUnsafe<{ ctx: string }[]>(`SELECT COALESCE(current_setting('app.tenant_id', true), '') AS ctx`);
        return { rows, ctx };
      });

      const byTenant = new Map(result.rows.map((r) => [r.tenant_id, r]));
      expect(byTenant.get(a.tenantId)).toMatchObject({ users: 2, patients: 1 });
      expect(byTenant.get(b.tenantId)).toMatchObject({ users: 1, patients: 0 });
      expect(result.ctx).toBe('');
    });

    it('n’est pas exécutable par le rôle applicatif ni par PUBLIC', async () => {
      await expect(asTenant(a.tenantId, `SELECT * FROM platform.tenants_usage(NULL, now())`)).rejects.toThrow(/permission denied/i);
    });
  });

  describe('ghmt_app n’accède aux tables platform que par des fonctions étroites', () => {
    it.each(PLATFORM_ONLY_TABLES)('refuse SELECT sur platform.%s (permission denied)', async (table) => {
      await expect(asTenant(a.tenantId, `SELECT 1 FROM platform.${table} LIMIT 1`)).rejects.toThrow(/permission denied/i);
    });

    it('refuse l’écriture directe dans les abonnements et le journal d’audit plateforme', async () => {
      await expect(asTenant(a.tenantId, `UPDATE platform.subscriptions SET status = 'active' WHERE false`)).rejects.toThrow(/permission denied/i);
      await expect(
        asTenant(a.tenantId, `INSERT INTO platform.audit_logs (id, actor_type, action) VALUES (gen_random_uuid(), 'x', 'y')`),
      ).rejects.toThrow(/permission denied/i);
    });

    it('current_tenant_subscription() ne renvoie que l’abonnement du tenant du contexte', async () => {
      const rowsA = await asTenant<{ plan_code: string }[]>(a.tenantId, `SELECT plan_code FROM platform.current_tenant_subscription()`);
      const rowsB = await asTenant<{ plan_code: string }[]>(b.tenantId, `SELECT plan_code FROM platform.current_tenant_subscription()`);
      expect(rowsA.map((r) => r.plan_code)).toEqual(['enterprise']);
      expect(rowsB.map((r) => r.plan_code)).toEqual(['basic']);
    });

    it('start_trial est idempotent, plafonne le plan à Standard et borne la durée', async () => {
      const again = await asTenant<{ id: string | null }[]>(a.tenantId, `SELECT platform.start_trial('basic', 30, now()) AS id`);
      expect(again[0]!.id).toBeNull();
      await expect(asTenant(a.tenantId, `SELECT platform.start_trial('enterprise', 30, now())`)).rejects.toThrow(/trial plan/);
      await expect(asTenant(a.tenantId, `SELECT platform.start_trial('basic', 400, now())`)).rejects.toThrow(/invalid trial duration/);
    });

    it('next_saas_invoice_number n’est pas exécutable par le rôle applicatif', async () => {
      await expect(asTenant(a.tenantId, `SELECT platform.next_saas_invoice_number('SN', 2026)`)).rejects.toThrow(/permission denied/i);
    });
  });
});
