import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { AUDIT_EXPORT_LIMIT } from '../../src/modules/admin/admin.constants';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { AUDIT_LOGS, auditRows, postBinary, seedAudit, setSubscriptionStatus, sha256Hex } from './admin-fixtures';

const EXPORT = `${AUDIT_LOGS}/export`;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const HEADER =
  'seq;horodatage_utc;type_acteur;id_acteur;nom_acteur;action;type_ressource;id_ressource;id_patient;resultat;ip;id_requete;details_json';

const csvLines = (body: Buffer): string[] => body.subarray(3).toString('utf8').split('\r\n').filter((line) => line !== '');

/** Application et deux établissements amorcés ; chaque groupe a sa propre application (limite : 5 exports / 10 min / IP). */
function useExportApp(prefix: string) {
  const ctx = {} as { app: INestApplication; a: TenantFixture; b: TenantFixture; director: UserFixture; doctor: UserFixture };
  beforeAll(async () => {
    ctx.app = await createTestApp();
    const { app } = ctx;
    [ctx.a, ctx.b] = await Promise.all([createTenantFixture(app, { prefix: `${prefix}-a` }), createTenantFixture(app, { prefix: `${prefix}-b` })]);
    const { a, b } = ctx;
    ctx.director = await createUserWithRole(app, a, 'director');
    ctx.doctor = await createUserWithRole(app, a, 'doctor');
    const trapUser = await createUserWithRole(app, a, 'receptionist');
    await app.get(TenantDb).runAs(a.tenantId, (tx) =>
      tx.user.update({ where: { tenantId_id: { tenantId: a.tenantId, id: trapUser.userId } }, data: { fullName: '=cmd|calc' } }),
    );
    await seedAudit(app, a, [
      { action: 'seed.export', resourceType: 'widget', actorUserId: a.adminUserId, changes: { n: 1, comment: 'texte clinique libre' } },
      { action: 'seed.export', resourceType: 'widget', actorType: 'system', outcome: 'denied' },
      { action: 'seed.formula', resourceType: 'widget', actorUserId: trapUser.userId, changes: { reason: '=cmd|calc', label: '@SUM(1)', trap: '=HYPERLINK("x";"y")' } },
    ]);
    await seedAudit(app, b, [{ action: 'seed.export', resourceType: 'widget', actorUserId: b.adminUserId }]);
  });
  afterAll(async () => {
    await ctx.app?.close();
  });
  return ctx;
}

describe('POST /audit-logs/export : autorisation (HTTP)', () => {
  const ctx = useExportApp('exp-auth');

  it('refuse le directeur (audit:log:read sans export) et le médecin avec 403', async () => {
    expect((await postBinary(ctx.app, EXPORT, ctx.director.token)).status).toBe(403);
    expect((await postBinary(ctx.app, EXPORT, ctx.doctor.token)).status).toBe(403);
  });

  it('exige l’authentification', async () => {
    expect((await postBinary(ctx.app, EXPORT, 'jeton-invalide')).status).toBe(401);
  });

  it('refuse l’export en période de grâce avec 403 subscription_grace', async () => {
    await setSubscriptionStatus(ctx.app, ctx.a.tenantId, 'grace');

    const res = await postBinary(ctx.app, EXPORT, ctx.a.adminToken);

    await setSubscriptionStatus(ctx.app, ctx.a.tenantId, 'active');
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body.toString('utf8')).code).toBe('subscription_grace');
  });
});

describe('POST /audit-logs/export : contenu (HTTP)', () => {
  const ctx = useExportApp('exp-csv');

  it('renvoie un CSV non enveloppé : BOM, séparateur « ; », en-têtes HTTP et lignes conformes au contrat', async () => {
    const { app, a } = ctx;
    const res = await postBinary(app, EXPORT, a.adminToken, { action: 'seed.export' });

    expect(res.status).toBe(200);
    expect(String(res.headers['content-type'])).toBe('text/csv; charset=utf-8');
    expect(String(res.headers['content-disposition'])).toMatch(/^attachment; filename="journal-audit-\d{8}-\d{8}\.csv"$/);
    expect(res.body.subarray(0, 3).equals(BOM)).toBe(true);
    const lines = csvLines(res.body);
    expect(lines[0]).toBe(HEADER);
    expect(lines).toHaveLength(3);
    const adminLine = lines.find((line) => line.includes(a.adminUserId))!;
    const cells = adminLine.split(';');
    expect(cells.slice(2, 6)).toEqual(['user', a.adminUserId, 'Admin Test', 'seed.export']);
    expect(cells[6]).toBe('widget');
    expect(cells[9]).toBe('success');
    expect(adminLine).toContain('""n"":1');
    expect(lines.some((line) => line.includes('system') && line.includes('denied'))).toBe(true);
  });

  it('assainit les changements de l’export comme ceux de la liste (aucune donnée clinique)', async () => {
    const res = await postBinary(ctx.app, EXPORT, ctx.a.adminToken, { action: 'seed.export' });
    const text = res.body.toString('utf8');

    expect(text).not.toContain('texte clinique libre');
    expect(text).toContain('[masqué]');
  });

  it('neutralise l’injection de formules : aucune cellule ne commence par = + - @ tab ou retour chariot', async () => {
    const res = await postBinary(ctx.app, EXPORT, ctx.a.adminToken, { action: 'seed.formula' });
    const text = res.body.subarray(3).toString('utf8');

    expect(res.status).toBe(200);
    expect(text).not.toMatch(/(?:^|;|\r\n)"?[=+\-@\t]/m);
    expect(text).toContain(";'=cmd|calc;");
  });

  it('écrit l’audit audit.logs_exported (filtres, nombre de lignes, SHA-256 du fichier) avant l’envoi', async () => {
    const { app, a } = ctx;
    const res = await postBinary(app, EXPORT, a.adminToken, { action: 'seed.export', outcome: 'denied' });

    const rows = await auditRows(app, a, 'audit.logs_exported');
    const last = rows[rows.length - 1]!;
    expect(res.status).toBe(200);
    expect(last.actorUserId).toBe(a.adminUserId);
    expect(last.changes).toMatchObject({ rowCount: 1, sha256: sha256Hex(res.body), filters: { action: 'seed.export', outcome: 'denied' } });
  });

  it('n’exporte jamais les événements d’un autre établissement', async () => {
    const res = await postBinary(ctx.app, EXPORT, ctx.b.adminToken, { action: 'seed.export' });
    const lines = csvLines(res.body);

    expect(res.status).toBe(200);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain(ctx.b.adminUserId);
    expect(res.body.toString('utf8')).not.toContain(ctx.a.adminUserId);
  });
});

describe('POST /audit-logs/export : validation et plafond (HTTP)', () => {
  let app: INestApplication;
  let a: TenantFixture;

  beforeAll(async () => {
    app = await createTestApp({}, { providerOverrides: [{ token: AUDIT_EXPORT_LIMIT, useValue: 2 }] });
    a = await createTenantFixture(app, { prefix: 'exp-big' });
    await seedAudit(app, a, [{ action: 'seed.big' }, { action: 'seed.big' }, { action: 'seed.big' }]);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('refuse un export dépassant le plafond avec 422 export_too_large et le détail (count, max)', async () => {
    const res = await postBinary(app, EXPORT, a.adminToken, { action: 'seed.big' });

    const body = JSON.parse(res.body.toString('utf8'));
    expect(res.status).toBe(422);
    expect(body.code).toBe('export_too_large');
    expect(body.details).toEqual({ count: 3, max: 2 });
  });

  it('accepte un export exactement au plafond', async () => {
    const res = await postBinary(app, EXPORT, a.adminToken, { action: 'seed.big', outcome: 'denied' });

    expect(res.status).toBe(200);
    expect(csvLines(res.body)).toHaveLength(1);
  });

  it('refuse un filtre invalide et une période de plus de 92 jours avec 422', async () => {
    const invalid = await postBinary(app, EXPORT, a.adminToken, { action: 'Pas Valide' });
    const range = await postBinary(app, EXPORT, a.adminToken, { from: '2026-01-01T00:00:00Z', to: '2026-10-01T00:00:00Z' });

    expect(invalid.status).toBe(422);
    expect(range.status).toBe(422);
    expect(JSON.parse(range.body.toString('utf8')).code).toBe('range_too_large');
  });
});

describe('POST /audit-logs/export : limitation de débit (HTTP)', () => {
  let app: INestApplication;
  let a: TenantFixture;

  beforeAll(async () => {
    app = await createTestApp();
    a = await createTenantFixture(app, { prefix: 'exp-rate' });
  });

  afterAll(async () => {
    await app?.close();
  });

  it('répond 429 à la 6e demande en 10 minutes pour une même IP', async () => {
    for (let i = 0; i < 5; i += 1) expect((await postBinary(app, EXPORT, a.adminToken, { action: 'seed.rate' })).status).toBe(200);

    const sixth = await postBinary(app, EXPORT, a.adminToken, { action: 'seed.rate' });

    expect(sixth.status).toBe(429);
  });
});
