import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeCursor } from '../../src/common/pagination/page';
import { TenantDb } from '../../src/infrastructure/prisma/tenant-db.service';
import { createPatientRow } from '../appointments/appointment-fixtures';
import { createTenantFixture, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { AUDIT_LOGS, auditRows, bearer, http, seedAudit } from './admin-fixtures';

const UNKNOWN_ID = '018f0000-0000-7000-8000-000000000000';
const MASKED = '[masqué]';

interface LogItem {
  id: string;
  seq: string;
  occurredAt: string;
  actor: { type: string; userId: string | null; fullName: string | null };
  action: string;
  resourceType: string | null;
  resourceId: string | null;
  patientId: string | null;
  outcome: string;
  changes: Record<string, unknown> | null;
  [key: string]: unknown;
}

describe('GET /audit-logs (HTTP)', () => {
  let app: INestApplication;
  let a: TenantFixture;
  let b: TenantFixture;
  let doctor: UserFixture;
  let director: UserFixture;
  let patientId: string;
  const patientLastName = 'Ndiaye-Secret';
  const resourceA = '018f0000-0000-7000-8000-0000000000a1';
  const resourceB = '018f0000-0000-7000-8000-0000000000b1';

  const list = (token: string, query: Record<string, string | number> = {}) =>
    http(app).get(AUDIT_LOGS).query(query).set(bearer({ token }));
  const items = (res: { body: { data: LogItem[] } }): LogItem[] => res.body.data;

  beforeAll(async () => {
    app = await createTestApp();
    [a, b] = await Promise.all([createTenantFixture(app, { prefix: 'aud-a' }), createTenantFixture(app, { prefix: 'aud-b' })]);
    doctor = await createUserWithRole(app, a, 'doctor');
    director = await createUserWithRole(app, a, 'director');
    patientId = await createPatientRow(app, a);
    await app.get(TenantDb).runAs(a.tenantId, (tx) => tx.patient.update({ where: { tenantId_id: { tenantId: a.tenantId, id: patientId } }, data: { lastName: patientLastName } }));
    await seedAudit(app, a, [
      { action: 'seed.alpha', resourceType: 'widget', resourceId: resourceA, actorUserId: a.adminUserId, actorType: 'user', changes: { n: 1 } },
      { action: 'seed.beta', resourceType: 'widget', actorType: 'system', outcome: 'failure', changes: { reason: 'permission_denied' } },
      { action: 'seed.other.deep', resourceType: 'gadget', actorUserId: a.adminUserId, outcome: 'denied' },
      { action: 'seedling.shadow', resourceType: 'gadget', actorType: 'system' },
      {
        action: 'seed.sensitive',
        resourceType: 'patient',
        patientId,
        actorUserId: a.adminUserId,
        changes: {
          forceReason: 'VIH positif confirmé',
          cancelReason: 'décès du patient',
          comment: 'commentaire clinique',
          fullName: `Awa ${patientLastName}`,
          reason: 'Motif libre du patient',
          nested: { phone: '+221771234567', email: 'awa@mail.sn', keep: 'ok' },
          patientIds: Array.from({ length: 60 }, (_, i) => `00000000-0000-7000-8000-${String(i).padStart(12, '0')}`),
        },
      },
    ]);
    await seedAudit(app, b, [{ action: 'seed.alpha', resourceType: 'widget', resourceId: resourceB, actorUserId: b.adminUserId, actorType: 'user' }]);
    for (let i = 0; i < 7; i += 1) await seedAudit(app, a, [{ action: 'seed.page', resourceType: 'paging', actorType: 'system', changes: { i } }]);
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('autorisation et validation', () => {
    it('refuse un médecin (403) et exige l’authentification (401)', async () => {
      await list(doctor.token).expect(403);
      await http(app).get(AUDIT_LOGS).expect(401);
    });

    it('autorise le directeur (audit:log:read)', async () => {
      await list(director.token, { action: 'seed.alpha' }).expect(200);
    });

    it.each([
      [{ limit: 0 }],
      [{ limit: 101 }],
      [{ action: 'Pas Valide' }],
      [{ resourceType: 'Bad' }],
      [{ outcome: 'maybe' }],
      [{ actorUserId: 'nope' }],
      [{ resourceId: 'nope' }],
      [{ from: 'hier' }],
      [{ from: '2026-10-05T00:00:00Z', to: '2026-10-01T00:00:00Z' }],
    ])('rejette le filtre invalide %j avec 422', async (query) => {
      const res = await list(a.adminToken, query as Record<string, string | number>).expect(422);

      expect(res.body.code ?? res.body.error?.code).toBeDefined();
    });

    it('rejette une période de plus de 92 jours avec 422 range_too_large', async () => {
      const to = new Date();
      const from = new Date(to.getTime() - 93 * 24 * 60 * 60 * 1000);

      const res = await list(a.adminToken, { from: from.toISOString(), to: to.toISOString() }).expect(422);

      expect(JSON.stringify(res.body)).toContain('range_too_large');
    });

    it.each(['abc', '-5', '1.5', '99999999999999999999'])('rejette le curseur décodé « %s » avec 422', async (decoded) => {
      await list(a.adminToken, { cursor: encodeCursor(decoded) }).expect(422);
    });

    it('rejette un curseur qui n’est pas du base64url valide', async () => {
      await list(a.adminToken, { cursor: '!!!' }).expect(422);
    });
  });

  describe('lecture et filtres', () => {
    it('trie par numéro de chaîne décroissant et sérialise le contrat de vue', async () => {
      const res = await list(a.adminToken, { action: 'seed.*' }).expect(200);
      const rows = items(res);

      expect(rows.length).toBeGreaterThanOrEqual(5);
      const seqs = rows.map((row) => BigInt(row.seq));
      expect([...seqs].sort((x, y) => (x < y ? 1 : -1))).toEqual(seqs);
      expect(rows.find((row) => row.action === 'seed.alpha')).toMatchObject({
        id: expect.any(String),
        seq: expect.stringMatching(/^\d+$/),
        occurredAt: expect.stringMatching(/Z$/),
        actor: { type: 'user', userId: a.adminUserId, fullName: 'Admin Test' },
        resourceType: 'widget',
        resourceId: resourceA,
        patientId: null,
        outcome: 'success',
        changes: { n: 1 },
      });
      expect(rows.find((row) => row.action === 'seed.beta')?.actor).toEqual({ type: 'system', userId: null, fullName: null });
    });

    it('filtre par action exacte (sans correspondance partielle) et par préfixe .*', async () => {
      const exact = items(await list(a.adminToken, { action: 'seed.alpha' }).expect(200));
      const prefix = items(await list(a.adminToken, { action: 'seed.*' }).expect(200));

      expect(exact.map((row) => row.action)).toEqual(['seed.alpha']);
      expect(prefix.every((row) => row.action.startsWith('seed.'))).toBe(true);
      expect(prefix.map((row) => row.action)).toEqual(expect.arrayContaining(['seed.alpha', 'seed.beta', 'seed.other.deep']));
      expect(prefix.map((row) => row.action)).not.toContain('seedling.shadow');
    });

    it('filtre par acteur, type de ressource, identifiant de ressource et résultat', async () => {
      const byActor = items(await list(a.adminToken, { actorUserId: a.adminUserId, action: 'seed.*' }).expect(200));
      const byType = items(await list(a.adminToken, { resourceType: 'gadget' }).expect(200));
      const byId = items(await list(a.adminToken, { resourceId: resourceA }).expect(200));
      const byOutcome = items(await list(a.adminToken, { outcome: 'denied', action: 'seed.*' }).expect(200));

      expect(byActor.length).toBeGreaterThan(0);
      expect(byActor.every((row) => row.actor.userId === a.adminUserId)).toBe(true);
      expect(byType.map((row) => row.action).sort()).toEqual(['seed.other.deep', 'seedling.shadow']);
      expect(byId.map((row) => row.action)).toEqual(['seed.alpha']);
      expect(byOutcome.map((row) => row.action)).toEqual(['seed.other.deep']);
    });

    it('applique la période : une fenêtre dans le futur ou entièrement passée est vide, une fenêtre englobante non', async () => {
      const now = Date.now();
      const iso = (offsetMs: number) => new Date(now + offsetMs).toISOString();
      const hour = 3_600_000;

      const future = items(await list(a.adminToken, { action: 'seed.*', from: iso(hour), to: iso(2 * hour) }).expect(200));
      const past = items(await list(a.adminToken, { action: 'seed.*', from: iso(-48 * hour), to: iso(-24 * hour) }).expect(200));
      const around = items(await list(a.adminToken, { action: 'seed.*', from: iso(-hour), to: iso(hour) }).expect(200));

      expect(future).toEqual([]);
      expect(past).toEqual([]);
      expect(around.length).toBeGreaterThanOrEqual(5);
    });

    it('pagine par curseur stable : pages disjointes qui reconstituent exactement la liste complète', async () => {
      const everything = items(await list(a.adminToken, { resourceType: 'paging', limit: 100 }).expect(200));
      const collected: LogItem[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const res = await list(a.adminToken, { resourceType: 'paging', limit: 3, ...(cursor ? { cursor } : {}) }).expect(200);
        collected.push(...items(res));
        const pagination = res.body.meta.pagination;
        expect(pagination).toMatchObject({ mode: 'cursor', limit: 3 });
        cursor = pagination.nextCursor ?? undefined;
        pages += 1;
      } while (cursor && pages < 10);

      expect(everything).toHaveLength(7);
      expect(pages).toBe(3);
      expect(collected.map((row) => row.id)).toEqual(everything.map((row) => row.id));
    });

    it('un événement ajouté pendant la pagination ne décale pas les pages suivantes', async () => {
      const first = await list(a.adminToken, { resourceType: 'paging', limit: 3 }).expect(200);
      await seedAudit(app, a, [{ action: 'seed.page', resourceType: 'paging', actorType: 'system' }]);

      const second = await list(a.adminToken, { resourceType: 'paging', limit: 3, cursor: first.body.meta.pagination.nextCursor }).expect(200);

      const seenFirst = new Set(items(first).map((row) => row.id));
      expect(items(second).every((row) => !seenFirst.has(row.id))).toBe(true);
      expect(items(second)).toHaveLength(3);
    });
  });

  describe('aucune donnée clinique', () => {
    it('masque les textes libres, tronque et borne patientIds, conserve les codes', async () => {
      const res = await list(a.adminToken, { action: 'seed.sensitive' }).expect(200);
      const changes = items(res)[0]!.changes!;

      expect(changes).toMatchObject({
        forceReason: MASKED,
        cancelReason: MASKED,
        comment: MASKED,
        fullName: MASKED,
        reason: MASKED,
        nested: { phone: MASKED, email: MASKED, keep: 'ok' },
        patientIdsCount: 60,
      });
      expect(changes['patientIds']).toHaveLength(50);
    });

    it('ne laisse fuiter aucun fragment de donnée clinique ni le nom du patient dans la réponse brute', async () => {
      const res = await list(a.adminToken, { action: 'seed.sensitive' }).expect(200);
      const raw = JSON.stringify(res.body);

      for (const secret of ['VIH', 'décès', 'clinique', patientLastName, 'Awa', '+221771234567', 'awa@mail.sn', 'Motif libre']) {
        expect(raw).not.toContain(secret);
      }
    });

    it('restitue le nom du personnel uniquement (jointure users), jamais celui d’un patient', async () => {
      const res = await list(a.adminToken, { action: 'seed.sensitive' }).expect(200);

      expect(items(res)[0]).toMatchObject({ patientId, actor: { fullName: 'Admin Test' } });
    });
  });

  describe('isolation entre établissements', () => {
    it('ne montre jamais les événements d’un autre tenant, même avec un resourceId connu', async () => {
      const own = items(await list(b.adminToken, { resourceId: resourceB }).expect(200));
      const foreign = items(await list(b.adminToken, { resourceId: resourceA }).expect(200));
      const all = items(await list(b.adminToken, { action: 'seed.*', limit: 100 }).expect(200));

      expect(own).toHaveLength(1);
      expect(foreign).toEqual([]);
      expect(all.map((row) => row.resourceId)).not.toContain(resourceA);
      expect(all.every((row) => row.action === 'seed.alpha')).toBe(true);
    });

    it('ne filtre pas sur un acteur d’un autre tenant (aucune ligne, pas d’erreur)', async () => {
      const res = await list(b.adminToken, { actorUserId: a.adminUserId }).expect(200);

      expect(items(res)).toEqual([]);
    });
  });

  describe('méta-audit', () => {
    it('trace chaque lecture (audit.logs_read) avec les filtres et le nombre de résultats', async () => {
      const res = await list(a.adminToken, { action: 'seed.alpha', outcome: 'success' }).expect(200);

      const rows = await auditRows(app, a, 'audit.logs_read');
      const last = rows[rows.length - 1]!;
      expect(items(res)).toHaveLength(1);
      expect(last.actorUserId).toBe(a.adminUserId);
      expect(last.changes).toMatchObject({ resultCount: 1, filters: { action: 'seed.alpha', outcome: 'success' } });
    });

    it('n’audite pas une lecture refusée comme une lecture réussie (le refus est tracé par le garde)', async () => {
      const before = (await auditRows(app, a, 'audit.logs_read')).length;

      await list(doctor.token).expect(403);

      expect((await auditRows(app, a, 'audit.logs_read')).length).toBe(before);
      expect((await auditRows(app, a, 'authz.denied')).length).toBeGreaterThan(0);
    });

    it('n’expose pas l’UUID inconnu comme erreur : un resourceId sans événement donne une liste vide', async () => {
      const res = await list(a.adminToken, { resourceId: UNKNOWN_ID }).expect(200);

      expect(items(res)).toEqual([]);
    });
  });
});
