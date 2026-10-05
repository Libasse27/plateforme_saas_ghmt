import { describe, expect, it } from 'vitest';
import { uuidv7 } from './uuid-v7';

describe('uuidv7', () => {
  it('produit un UUID version 7 de variante RFC 4122', () => {
    expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('encode l’horodatage en millisecondes dans les 48 premiers bits', () => {
    const at = Date.UTC(2100, 9, 5, 12, 0, 0);

    const id = uuidv7(at);

    expect(Number.parseInt(id.replace('-', '').slice(0, 12), 16)).toBe(at);
  });

  it('est strictement croissant, même au sein d’une même milliseconde', () => {
    const ids = Array.from({ length: 5000 }, () => uuidv7());

    const sorted = [...ids].sort();
    expect(sorted).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('reste croissant quand l’horloge recule légèrement', () => {
    const first = uuidv7(Date.UTC(2026, 9, 5, 12, 0, 1));
    const second = uuidv7(Date.UTC(2026, 9, 5, 12, 0, 0));

    expect(second > first).toBe(true);
  });
});
