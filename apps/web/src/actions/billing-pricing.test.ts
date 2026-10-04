import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { okEnvelope, problem } from '@/lib/api/test-helpers';

vi.mock('next/navigation', async () => (await import('./test-kit')).navigationMock());
vi.mock('next/cache', async () => (await import('./test-kit')).cacheMock());
vi.mock('next/headers', async () => (await import('./test-kit')).headersMock());

import { createPriceItemAction, createPriceListAction, setDefaultPriceListAction, updatePriceItemAction } from './billing-pricing';
import { form, stubApi } from './test-kit';

const LIST = 'bb2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
const ITEM = 'cc2b8c1e-1a2b-4c3d-8e9f-0123456789ab';

beforeEach(() => {
  vi.stubEnv('API_URL', 'http://api.test/api/v1');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('grille tarifaire', () => {
  it('crée une grille (case « par défaut » cochée)', async () => {
    const { calls } = stubApi(() => okEnvelope({ id: LIST }, {}, 201));
    const state = await createPriceListAction({}, form({ code: 'STD', name: 'Tarifs 2026', isDefault: 'on' }));
    expect(state.ok).toBe(true);
    expect(calls.at(-1)?.body).toEqual({ code: 'STD', name: 'Tarifs 2026', isDefault: true });
  });
  it('code invalide ou déjà pris', async () => {
    stubApi(() => problem(409, 'price_list_code_taken'));
    expect((await createPriceListAction({}, form({ code: '', name: 'x' }))).fieldErrors?.code).toBeDefined();
    expect((await createPriceListAction({}, form({ code: 'STD', name: 'Tarifs' }))).message).toContain('grille');
  });
  it('désigne la grille par défaut', async () => {
    const { calls } = stubApi(() => okEnvelope({ id: LIST }));
    expect((await setDefaultPriceListAction({}, form({ priceListId: LIST }))).ok).toBe(true);
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', path: `/billing/price-lists/${LIST}`, body: { isDefault: true } });
    expect((await setDefaultPriceListAction({}, form({ priceListId: 'x' }))).ok).toBe(false);
    stubApi(() => problem(403, 'permission_denied'));
    expect((await setDefaultPriceListAction({}, form({ priceListId: LIST }))).message).toContain('autorisation');
  });
});

describe('articles', () => {
  it('ajoute un article avec un prix normalisé', async () => {
    const { calls } = stubApi(() => okEnvelope({ id: ITEM }, {}, 201));
    const state = await createPriceItemAction({}, form({ priceListId: LIST, code: 'CONS-01', label: 'Consultation générale', category: 'consultation', unitPrice: '5 000' }));
    expect(state.ok).toBe(true);
    expect(calls.at(-1)).toMatchObject({ path: `/billing/price-lists/${LIST}/items`, body: { code: 'CONS-01', unitPrice: '5000.00', category: 'consultation', isActive: true } });
  });
  it('prix, catégorie ou grille invalides, code déjà pris', async () => {
    stubApi(() => problem(409, 'price_list_item_code_taken'));
    const bad = await createPriceItemAction({}, form({ priceListId: LIST, code: 'C', label: 'Consultation', category: 'zzz', unitPrice: 'x' }));
    expect(bad.fieldErrors?.unitPrice).toBeDefined();
    expect(bad.fieldErrors?.category).toBeDefined();
    expect((await createPriceItemAction({}, form({ priceListId: 'x' }))).ok).toBe(false);
    expect((await createPriceItemAction({}, form({ priceListId: LIST, code: 'C', label: 'Consultation', category: 'acte', unitPrice: '1' }))).message).toContain('code d\'article');
  });
  it('modifie un prix, active ou désactive', async () => {
    const { calls } = stubApi(() => okEnvelope({ id: ITEM }));
    expect((await updatePriceItemAction({}, form({ itemId: ITEM, unitPrice: '6 000' }))).ok).toBe(true);
    expect(calls.at(-1)?.body).toEqual({ unitPrice: '6000.00' });
    await updatePriceItemAction({}, form({ itemId: ITEM, isActive: 'false' }));
    expect(calls.at(-1)?.body).toEqual({ isActive: false });
  });
  it('rejette un prix invalide, un patch vide, un identifiant invalide et propage l\'erreur API', async () => {
    stubApi(() => problem(403, 'permission_denied'));
    expect((await updatePriceItemAction({}, form({ itemId: ITEM, unitPrice: 'x' }))).fieldErrors?.unitPrice).toBeDefined();
    expect((await updatePriceItemAction({}, form({ itemId: ITEM }))).ok).toBe(false);
    expect((await updatePriceItemAction({}, form({ itemId: 'x', unitPrice: '1' }))).ok).toBe(false);
    expect((await updatePriceItemAction({}, form({ itemId: ITEM, unitPrice: '1' }))).message).toContain('autorisation');
  });
});
