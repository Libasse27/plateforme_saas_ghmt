import type { INestApplication } from '@nestjs/common';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTenantFixture, createUserWithPermissions, createUserWithRole, type TenantFixture, type UserFixture } from '../helpers/fixtures';
import { createTestApp } from '../helpers/test-app';
import { BILLING, UNKNOWN_ID, auditActions, bearer, createBillingTenant, http } from './billing-fixtures';

describe('grille tarifaire (HTTP)', () => {
  let app: INestApplication;
  let a: TenantFixture;
  let b: TenantFixture;
  let manager: UserFixture;
  let reader: UserFixture;
  let cashier: UserFixture;
  let nurse: UserFixture;
  let otherManager: UserFixture;

  beforeAll(async () => {
    app = await createTestApp();
    [a, b] = await Promise.all([createBillingTenant(app, 'grille-a'), createBillingTenant(app, 'grille-b')]);
    manager = await createUserWithPermissions(app, a, ['billing:price_list:read', 'billing:price_list:update']);
    reader = await createUserWithPermissions(app, a, ['billing:price_list:read']);
    cashier = await createUserWithRole(app, a, 'cashier');
    nurse = await createUserWithRole(app, a, 'nurse');
    otherManager = await createUserWithPermissions(app, b, ['billing:price_list:read', 'billing:price_list:update']);
  });

  afterAll(async () => {
    await app?.close();
  });

  const createList = (user: UserFixture, body: Record<string, unknown>) => http(app).post(`${BILLING}/price-lists`).set(bearer(user)).send(body);
  const createItem = (user: UserFixture, listId: string, body: Record<string, unknown>) =>
    http(app).post(`${BILLING}/price-lists/${listId}/items`).set(bearer(user)).send(body);

  describe('listes de prix', () => {
    it('crée une grille dans la devise de l’établissement par défaut et l’audite', async () => {
      const res = await createList(manager, { code: 'STANDARD', name: 'Tarif standard' }).expect(201);

      expect(res.body.data).toMatchObject({ code: 'STANDARD', name: 'Tarif standard', currency: 'XOF', isDefault: false, isActive: true });
      const audit = await auditActions(app, a, 'price_list.created', res.body.data.id);
      expect(audit).toHaveLength(1);
    });

    it('refuse un code déjà utilisé (409) et un corps invalide (422)', async () => {
      await createList(manager, { code: 'DOUBLON', name: 'Une' }).expect(201);

      const duplicate = await createList(manager, { code: 'DOUBLON', name: 'Deux' }).expect(409);
      expect(duplicate.body.code).toBe('price_list_code_taken');
      await createList(manager, { code: 'x y', name: '' }).expect(422);
      await createList(manager, { code: 'DEV', name: 'Devise', currency: 'xof' }).expect(422);
    });

    it('une seule grille par défaut : en désigner une autre retire la précédente', async () => {
      const first = (await createList(manager, { code: 'DEF-1', name: 'Première', isDefault: true }).expect(201)).body.data;
      const second = (await createList(manager, { code: 'DEF-2', name: 'Seconde', isDefault: true }).expect(201)).body.data;

      const lists = (await http(app).get(`${BILLING}/price-lists`).set(bearer(reader)).expect(200)).body.data as { id: string; isDefault: boolean }[];

      expect(lists.filter((l) => l.isDefault).map((l) => l.id)).toEqual([second.id]);
      expect(lists.find((l) => l.id === first.id)?.isDefault).toBe(false);
    });

    it('modifie le nom et l’état, 404 si inconnue', async () => {
      const list = (await createList(manager, { code: 'MAJ', name: 'Avant' }).expect(201)).body.data;

      const res = await http(app).patch(`${BILLING}/price-lists/${list.id}`).set(bearer(manager)).send({ name: 'Après', isActive: false }).expect(200);

      expect(res.body.data).toMatchObject({ name: 'Après', isActive: false });
      await http(app).patch(`${BILLING}/price-lists/${UNKNOWN_ID}`).set(bearer(manager)).send({ name: 'X1' }).expect(404);
      await http(app).patch(`${BILLING}/price-lists/${list.id}`).set(bearer(manager)).send({}).expect(422);
    });
  });

  describe('articles', () => {
    let listId: string;

    beforeAll(async () => {
      listId = (await createList(manager, { code: 'ARTICLES', name: 'Articles' }).expect(201)).body.data.id;
    });

    it('crée un article avec un prix décimal exact et le relit', async () => {
      const res = await createItem(manager, listId, { code: 'CONS-GEN', label: 'Consultation générale', category: 'consultation', unitPrice: '5000.00' }).expect(201);

      expect(res.body.data).toMatchObject({ code: 'CONS-GEN', unitPrice: '5000.00', category: 'consultation', isActive: true, priceListId: listId });
    });

    it('refuse un prix flottant, un prix à 3 décimales, une catégorie inconnue (422) et un code en doublon (409)', async () => {
      await createItem(manager, listId, { code: 'P1', label: 'Prix flottant', category: 'acte', unitPrice: 12.5 }).expect(422);
      await createItem(manager, listId, { code: 'P2', label: 'Trois décimales', category: 'acte', unitPrice: '1.234' }).expect(422);
      await createItem(manager, listId, { code: 'P3', label: 'Catégorie', category: 'inconnue', unitPrice: '1' }).expect(422);
      await createItem(manager, listId, { code: 'DUP', label: 'Un', category: 'acte', unitPrice: '1' }).expect(201);
      const dup = await createItem(manager, listId, { code: 'DUP', label: 'Deux', category: 'acte', unitPrice: '1' }).expect(409);
      expect(dup.body.code).toBe('price_list_item_code_taken');
    });

    it('liste avec filtres (catégorie, recherche, inactifs) et pagination par curseur', async () => {
      const list = (await createList(manager, { code: 'FILTRES', name: 'Filtres' }).expect(201)).body.data.id;
      for (const [code, label, category] of [['A1', 'Radio thorax', 'examen'], ['A2', 'Radio genou', 'examen'], ['A3', 'Pansement', 'acte']]) {
        await createItem(manager, list, { code, label, category, unitPrice: '100' }).expect(201);
      }
      const inactive = (await createItem(manager, list, { code: 'A4', label: 'Radio ancienne', category: 'examen', unitPrice: '100' }).expect(201)).body.data;
      await http(app).patch(`${BILLING}/price-list-items/${inactive.id}`).set(bearer(manager)).send({ isActive: false }).expect(200);

      const radios = await http(app).get(`${BILLING}/price-lists/${list}/items?q=radio`).set(bearer(reader)).expect(200);
      expect(radios.body.data.map((i: { code: string }) => i.code).sort()).toEqual(['A1', 'A2']);
      const all = await http(app).get(`${BILLING}/price-lists/${list}/items?includeInactive=true`).set(bearer(reader)).expect(200);
      expect(all.body.data).toHaveLength(4);
      const exams = await http(app).get(`${BILLING}/price-lists/${list}/items?category=examen`).set(bearer(reader)).expect(200);
      expect(exams.body.data).toHaveLength(2);
      const page1 = await http(app).get(`${BILLING}/price-lists/${list}/items?limit=2`).set(bearer(reader)).expect(200);
      expect(page1.body.meta.pagination).toMatchObject({ limit: 2, hasMore: true });
      const page2 = await http(app).get(`${BILLING}/price-lists/${list}/items?limit=2&cursor=${page1.body.meta.pagination.nextCursor}`).set(bearer(reader)).expect(200);
      expect(page2.body.data).toHaveLength(1);
      await http(app).get(`${BILLING}/price-lists/${list}/items?cursor=!!`).set(bearer(reader)).expect(422);
    });

    it('modifie le prix, le libellé et la catégorie d’un article et audite ancien et nouveau prix', async () => {
      const item = (await createItem(manager, listId, { code: 'MAJ-PRIX', label: 'À modifier', category: 'acte', unitPrice: '100.00' }).expect(201)).body.data;

      const res = await http(app).patch(`${BILLING}/price-list-items/${item.id}`).set(bearer(manager)).send({ unitPrice: '120.00', label: 'Modifié' }).expect(200);

      expect(res.body.data).toMatchObject({ unitPrice: '120.00', label: 'Modifié' });
      const [audit] = await auditActions(app, a, 'price_list_item.updated', item.id);
      expect(audit?.changes).toMatchObject({ unitPrice: { from: '100.00', to: '120.00' } });
      await http(app).patch(`${BILLING}/price-list-items/${item.id}`).set(bearer(manager)).send({ unitPrice: '1.999' }).expect(422);
      await http(app).patch(`${BILLING}/price-list-items/${UNKNOWN_ID}`).set(bearer(manager)).send({ label: 'Xx' }).expect(404);
    });
  });

  describe('droits et isolation', () => {
    it('refuse sans permission (403) : lecture seule ne modifie pas, un rôle sans billing:price_list ne lit pas', async () => {
      await createList(reader, { code: 'NOPE', name: 'Interdit' }).expect(403);
      await http(app).get(`${BILLING}/price-lists`).set(bearer(nurse)).expect(403);
      // Le caissier consulte la grille pour facturer, mais ne la modifie pas.
      await http(app).get(`${BILLING}/price-lists`).set(bearer(cashier)).expect(200);
      await createList(cashier, { code: 'CAISSE', name: 'Interdit' }).expect(403);
      await http(app).get(`${BILLING}/price-lists`).expect(401);
    });

    it('cloisonne les tenants : 404 sur une grille ou un article d’un autre établissement, liste distincte', async () => {
      const theirs = (await createList(otherManager, { code: 'AUTRE', name: 'Autre tenant' }).expect(201)).body.data;
      const theirItem = (await createItem(otherManager, theirs.id, { code: 'X', label: 'Article', category: 'acte', unitPrice: '1' }).expect(201)).body.data;

      await http(app).get(`${BILLING}/price-lists/${theirs.id}/items`).set(bearer(manager)).expect(404);
      await http(app).patch(`${BILLING}/price-lists/${theirs.id}`).set(bearer(manager)).send({ name: 'Piraté' }).expect(404);
      await http(app).patch(`${BILLING}/price-list-items/${theirItem.id}`).set(bearer(manager)).send({ label: 'Piraté' }).expect(404);
      await createItem(manager, theirs.id, { code: 'Y', label: 'Article', category: 'acte', unitPrice: '1' }).expect(404);
      const lists = (await http(app).get(`${BILLING}/price-lists`).set(bearer(manager)).expect(200)).body.data as { id: string }[];
      expect(lists.some((l) => l.id === theirs.id)).toBe(false);
    });

    it('refuse un module billing désactivé (403)', async () => {
      const noBilling = await createTenantFixture(app, { prefix: 'grille-sans', optionalModules: ['appointments'] });
      const user = await createUserWithPermissions(app, noBilling, ['billing:price_list:read']);

      await http(app).get(`${BILLING}/price-lists`).set(bearer(user)).expect(403);
    });
  });
});
