import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { PENDING_SIGNUP_EXPIRY_DAYS, RESERVED_TENANT_SLUGS } from '@ghmt/shared';

/** Fonctions et tables de la migration 20261006000200_signup_hardening, avec les rôles réels (ghmt_app, ghmt_platform). */
describe('migration signup_hardening (docs/11 §3.2)', () => {
  let app: pg.Client;
  let platform: pg.Client;
  const created: string[] = [];

  beforeAll(async () => {
    app = new pg.Client({ connectionString: process.env['DATABASE_URL'] });
    platform = new pg.Client({ connectionString: process.env['PLATFORM_DATABASE_URL'] });
    await Promise.all([app.connect(), platform.connect()]);
  });

  afterAll(async () => {
    await Promise.all([app?.end(), platform?.end()]);
  });

  const register = (slug: string, status?: string) =>
    app.query<{ id: string }>(
      `SELECT platform.register_tenant($1, 'Établissement', NULL, 'clinic'::platform.establishment_type, 'SN', 'XOF', 'Africa/Dakar', ARRAY[]::text[]${status ? ', $2::platform.tenant_status' : ''})::text AS id`,
      status ? [slug, status] : [slug],
    );
  const uniq = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

  it('platform.reserved_slugs contient exactement RESERVED_TENANT_SLUGS', async () => {
    const { rows } = await platform.query<{ slug: string }>('SELECT slug FROM platform.reserved_slugs ORDER BY slug');

    expect(rows.map((r) => r.slug)).toEqual([...RESERVED_TENANT_SLUGS].sort());
  });

  it('ne donne aucun droit sur reserved_slugs à ghmt_app, mais en autorise la lecture via slug_status', async () => {
    await expect(app.query('SELECT slug FROM platform.reserved_slugs')).rejects.toThrow(/permission denied/);
    const { rows } = await app.query<{ s: string }>("SELECT platform.slug_status('admin') AS s");
    expect(rows[0]!.s).toBe('reserved');
  });

  it('exige un slug conforme dans reserved_slugs (CHECK)', async () => {
    await expect(platform.query("INSERT INTO platform.reserved_slugs (slug, reason) VALUES ('Mauvais Slug', 'x')")).rejects.toThrow(/check/i);
  });

  describe('platform.slug_status', () => {
    it.each([
      ['admin', 'reserved'],
      ['www', 'reserved'],
      ['xn--abc', 'reserved'],
      ['ghmt', 'reserved'],
      ['ghmt-demo', 'reserved'],
      ['clinique-libre-xyz', 'available'],
      ['admin-clinique', 'available'],
    ])('« %s » ⇒ %s', async (slug, expected) => {
      const { rows } = await app.query<{ s: string }>('SELECT platform.slug_status($1) AS s', [slug]);

      expect(rows[0]!.s).toBe(expected);
    });

    it('renvoie taken pour un tenant existant, y compris supprimé', async () => {
      const slug = uniq('taken');
      const { rows } = await register(slug);
      created.push(rows[0]!.id);
      expect((await app.query<{ s: string }>('SELECT platform.slug_status($1) AS s', [slug])).rows[0]!.s).toBe('taken');

      await platform.query("UPDATE platform.tenants SET deleted_at = now(), status = 'terminated' WHERE id = $1", [rows[0]!.id]);

      expect((await app.query<{ s: string }>('SELECT platform.slug_status($1) AS s', [slug])).rows[0]!.s).toBe('taken');
    });
  });

  describe('platform.register_tenant', () => {
    it('crée un tenant actif par défaut et pending sur demande', async () => {
      const active = await register(uniq('reg-a'));
      const pending = await register(uniq('reg-p'), 'pending');

      const { rows } = await platform.query<{ id: string; status: string }>('SELECT id::text, status::text FROM platform.tenants WHERE id = ANY($1::uuid[])', [[active.rows[0]!.id, pending.rows[0]!.id]]);
      const byId = new Map(rows.map((r) => [r.id, r.status]));
      expect(byId.get(active.rows[0]!.id)).toBe('active');
      expect(byId.get(pending.rows[0]!.id)).toBe('pending');
    });

    it.each(['terminated', 'suspended'])('refuse le statut initial « %s » (22023)', async (status) => {
      await expect(register(uniq('reg-bad'), status)).rejects.toMatchObject({ code: '22023' });
    });

    it.each(['admin', 'xn--clinique', 'ghmt-x', 'api'])('refuse le slug réservé « %s » (22023, reserved slug)', async (slug) => {
      await expect(register(slug)).rejects.toMatchObject({ code: '22023', message: expect.stringContaining('reserved slug') });
    });

    it('refuse toujours un slug mal formé (22023)', async () => {
      await expect(register('A_B')).rejects.toMatchObject({ code: '22023' });
    });

    it('a remplacé l’ancienne signature (une seule fonction register_tenant)', async () => {
      const { rows } = await platform.query<{ n: string }>("SELECT count(*)::text AS n FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace WHERE s.nspname = 'platform' AND p.proname = 'register_tenant'");

      expect(rows[0]!.n).toBe('1');
    });
  });

  describe('platform.activate_pending_tenant', () => {
    const activate = async (tenantId: string | null): Promise<boolean> => {
      await app.query('BEGIN');
      try {
        if (tenantId) await app.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        const { rows } = await app.query<{ ok: boolean }>('SELECT platform.activate_pending_tenant() AS ok');
        await app.query('COMMIT');
        return rows[0]!.ok;
      } catch (error) {
        await app.query('ROLLBACK');
        throw error;
      }
    };

    it('active uniquement le tenant courant en attente', async () => {
      const target = (await register(uniq('act-t'), 'pending')).rows[0]!.id;
      const other = (await register(uniq('act-o'), 'pending')).rows[0]!.id;

      expect(await activate(target)).toBe(true);

      const { rows } = await platform.query<{ id: string; status: string }>('SELECT id::text, status::text FROM platform.tenants WHERE id = ANY($1::uuid[])', [[target, other]]);
      expect(new Map(rows.map((r) => [r.id, r.status]))).toEqual(new Map([[target, 'active'], [other, 'pending']]));
    });

    it('renvoie faux sans contexte tenant, pour un tenant déjà actif, suspendu ou supprimé', async () => {
      const active = (await register(uniq('act-a'))).rows[0]!.id;
      const suspended = (await register(uniq('act-s'), 'pending')).rows[0]!.id;
      await platform.query("UPDATE platform.tenants SET status = 'suspended' WHERE id = $1", [suspended]);
      const deleted = (await register(uniq('act-d'), 'pending')).rows[0]!.id;
      await platform.query('UPDATE platform.tenants SET deleted_at = now() WHERE id = $1', [deleted]);

      expect(await activate(null)).toBe(false);
      expect(await activate(active)).toBe(false);
      expect(await activate(suspended)).toBe(false);
      expect(await activate(deleted)).toBe(false);
      const { rows } = await platform.query<{ status: string }>('SELECT status::text FROM platform.tenants WHERE id = $1', [suspended]);
      expect(rows[0]!.status).toBe('suspended');
    });
  });

  it('applique le RLS ENABLE + FORCE et la politique tenant_isolation à signup_verifications', async () => {
    const { rows } = await app.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean; policies: string }>(
      `SELECT c.relrowsecurity, c.relforcerowsecurity,
              (SELECT count(*)::text FROM pg_policies p WHERE p.schemaname = 'tenant' AND p.tablename = 'signup_verifications' AND p.policyname = 'tenant_isolation') AS policies
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'tenant' AND c.relname = 'signup_verifications'`,
    );

    expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true, policies: '1' });
  });

  it('ne donne à ghmt_platform aucun accès à signup_verifications', async () => {
    await expect(platform.query('SELECT 1 FROM tenant.signup_verifications')).rejects.toThrow(/permission denied/);
  });

  it('la constante d’expiration vaut 7 jours', () => {
    expect(PENDING_SIGNUP_EXPIRY_DAYS).toBe(7);
  });
});
