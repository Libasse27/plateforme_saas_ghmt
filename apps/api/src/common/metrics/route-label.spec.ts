import { describe, expect, it } from 'vitest';
import { UNMATCHED_ROUTE, routeLabel } from './route-label';

describe('routeLabel', () => {
  it('renvoie le gabarit de la route prise en charge, préfixe de routeur compris', () => {
    expect(routeLabel({ route: { path: '/api/v1/patients/:patientId' } })).toBe('/api/v1/patients/:patientId');
    expect(routeLabel({ baseUrl: '/api/v1', route: { path: '/health' } })).toBe('/api/v1/health');
  });

  it('regroupe les requêtes sans route (404, refus avant routage) sous un label unique', () => {
    expect(routeLabel({})).toBe(UNMATCHED_ROUTE);
    expect(routeLabel({ route: { path: /regex/ } })).toBe(UNMATCHED_ROUTE);
    expect(routeLabel({ route: { path: '' } })).toBe(UNMATCHED_ROUTE);
    // Route « attrape-tout » de Nest pour les 404 sous le préfixe global.
    expect(routeLabel({ route: { path: '/api/v1*path' } })).toBe(UNMATCHED_ROUTE);
  });
});
