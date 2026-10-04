import { describe, expect, it } from 'vitest';
import { extractClientInfo, forwardHeaders } from './client-info';

const h = (init: Record<string, string>) => new Headers(init);

describe('extractClientInfo', () => {
  it('prend l\'adresse ajoutée par le proxy amont (dernière entrée de x-forwarded-for)', () => {
    expect(extractClientInfo(h({ 'x-forwarded-for': '6.6.6.6, 203.0.113.9' })).ip).toBe('203.0.113.9');
  });
  it('ignore les entrées invalides de x-forwarded-for', () => {
    expect(extractClientInfo(h({ 'x-forwarded-for': '203.0.113.9, pas-une-ip' })).ip).toBeUndefined();
    expect(extractClientInfo(h({ 'x-forwarded-for': 'n\'importe quoi', 'x-real-ip': '198.51.100.4' })).ip).toBe('198.51.100.4');
  });
  it('retombe sur x-real-ip, accepte IPv6', () => {
    expect(extractClientInfo(h({ 'x-real-ip': '198.51.100.4' })).ip).toBe('198.51.100.4');
    expect(extractClientInfo(h({ 'x-forwarded-for': '2001:db8::1' })).ip).toBe('2001:db8::1');
  });
  it('sans en-tête exploitable, aucune IP', () => {
    expect(extractClientInfo(h({})).ip).toBeUndefined();
    expect(extractClientInfo(h({ 'x-real-ip': 'zzz' })).ip).toBeUndefined();
  });
  it('conserve le User-Agent tronqué et nettoyé', () => {
    expect(extractClientInfo(h({ 'user-agent': 'Mozilla/5.0' })).userAgent).toBe('Mozilla/5.0');
    expect(extractClientInfo(h({ 'user-agent': 'a'.repeat(1000) })).userAgent).toHaveLength(300);
    expect(extractClientInfo(h({})).userAgent).toBeUndefined();
  });
});

describe('forwardHeaders', () => {
  it('produit les en-têtes à transmettre à l\'API', () => {
    expect(forwardHeaders({ ip: '1.2.3.4', userAgent: 'UA' })).toEqual({ 'x-forwarded-for': '1.2.3.4', 'user-agent': 'UA' });
    expect(forwardHeaders({})).toEqual({});
    expect(forwardHeaders(undefined)).toEqual({});
  });
});
