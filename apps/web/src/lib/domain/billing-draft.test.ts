import { describe, expect, it } from 'vitest';
import { addCatalogLine, addFreeLine, draftTotal, removeLine, serializeLines, type DraftLine } from './billing-draft';
import { parseDraftLines } from './billing';

const ITEM = { id: '3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab', label: 'Consultation générale', unitPrice: '5000.00' };

describe('édition des lignes d\'une facture (immuable)', () => {
  it('ajoute une ligne catalogue sans modifier la liste d\'origine', () => {
    const original: DraftLine[] = [];
    const result = addCatalogLine(original, ITEM, '2', 'k1');
    expect(result.ok).toBe(true);
    expect(original).toEqual([]);
    if (result.ok) expect(result.lines).toEqual([{ key: 'k1', kind: 'catalog', priceListItemId: ITEM.id, label: 'Consultation générale', unitPrice: '5000.00', quantity: '2' }]);
  });

  it('fusionne la quantité d\'un article déjà présent', () => {
    const first = addCatalogLine([], ITEM, '1', 'k1');
    if (!first.ok) throw new Error('attendu');
    const second = addCatalogLine(first.lines, ITEM, '2,5', 'k2');
    expect(second.ok && second.lines).toEqual([expect.objectContaining({ key: 'k1', quantity: '3.5' })]);
  });

  it('refuse une quantité invalide', () => {
    expect(addCatalogLine([], ITEM, '0', 'k')).toMatchObject({ ok: false });
    expect(addCatalogLine([], ITEM, 'abc', 'k')).toMatchObject({ ok: false });
  });

  it('ajoute une ligne libre valide et refuse libellé, prix ou quantité invalides', () => {
    const ok = addFreeLine([], { description: ' Pansement ', category: 'acte', unitPrice: '1 500', quantity: '1' }, 'k');
    expect(ok.ok && ok.lines[0]).toMatchObject({ kind: 'free', description: 'Pansement', unitPrice: '1500.00', category: 'acte' });
    expect(addFreeLine([], { description: 'A', category: 'acte', unitPrice: '1', quantity: '1' }, 'k')).toMatchObject({ ok: false });
    expect(addFreeLine([], { description: 'Pansement', category: 'acte', unitPrice: 'x', quantity: '1' }, 'k')).toMatchObject({ ok: false });
    expect(addFreeLine([], { description: 'Pansement', category: 'acte', unitPrice: '1', quantity: '0' }, 'k')).toMatchObject({ ok: false });
    expect(addFreeLine([], { description: 'Pansement', category: 'zzz', unitPrice: '1', quantity: '1' }, 'k')).toMatchObject({ ok: false });
  });

  it('retire une ligne par clé', () => {
    const lines: DraftLine[] = [
      { key: 'a', kind: 'catalog', priceListItemId: ITEM.id, label: 'x', unitPrice: '1.00', quantity: '1' },
      { key: 'b', kind: 'catalog', priceListItemId: ITEM.id, label: 'y', unitPrice: '1.00', quantity: '1' },
    ];
    expect(removeLine(lines, 'a').map((l) => l.key)).toEqual(['b']);
    expect(lines).toHaveLength(2);
  });

  it('calcule le total d\'aperçu', () => {
    const a = addCatalogLine([], ITEM, '2', 'a');
    if (!a.ok) throw new Error('attendu');
    const b = addFreeLine(a.lines, { description: 'Pansement', category: 'acte', unitPrice: '1500', quantity: '1' }, 'b');
    if (!b.ok) throw new Error('attendu');
    expect(draftTotal(b.lines)).toBe('11500.00');
  });

  it('la sérialisation est relue sans perte par parseDraftLines', () => {
    const a = addCatalogLine([], ITEM, '2', 'a');
    if (!a.ok) throw new Error('attendu');
    const b = addFreeLine(a.lines, { description: 'Pansement', category: 'acte', unitPrice: '1500', quantity: '1' }, 'b');
    if (!b.ok) throw new Error('attendu');
    expect(parseDraftLines(serializeLines(b.lines), true)).toEqual({
      ok: true,
      lines: [
        { priceListItemId: ITEM.id, quantity: '2' },
        { description: 'Pansement', category: 'acte', unitPrice: '1500.00', quantity: '1' },
      ],
    });
  });
});
