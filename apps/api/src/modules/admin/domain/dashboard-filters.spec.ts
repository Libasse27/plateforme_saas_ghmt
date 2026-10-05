import { describe, expect, it } from 'vitest';
import { appointmentWhere, openSessionWhere, patientWhere, paymentWhere, registeredTodayWhere } from './dashboard-filters';

const TENANT = 't-1';
const ALL = { allTenant: true, siteIds: [], departmentIds: [] } as const;
const SITES = { allTenant: false, siteIds: ['s1'], departmentIds: ['d1'] } as const;
const DAY = { start: new Date('2026-10-05T00:00:00Z'), end: new Date('2026-10-06T00:00:00Z') };

describe('filtres du tableau de bord', () => {
  it('patientWhere : établissement entier sans filtre de site, et site demandé en plus de la portée', () => {
    expect(patientWhere(TENANT, ALL, [], undefined)).toEqual({ tenantId: TENANT, deletedAt: null, AND: [{}] });
    expect(patientWhere(TENANT, ALL, [], 's9')).toEqual({ tenantId: TENANT, deletedAt: null, AND: [{}, { primarySiteId: 's9' }] });
    expect(patientWhere(TENANT, SITES, ['s2'], undefined).AND).toEqual([{ OR: [{ primarySiteId: null }, { primarySiteId: { in: ['s1', 's2'] } }] }]);
  });

  it('registeredTodayWhere : borne [début, fin[ sur createdAt, sans muter la base', () => {
    const base = patientWhere(TENANT, ALL, [], undefined);

    expect(registeredTodayWhere(base, DAY)).toMatchObject({ createdAt: { gte: DAY.start, lt: DAY.end } });
    expect(base).not.toHaveProperty('createdAt');
  });

  it('appointmentWhere : portée par site ou service du praticien, bornes du jour, site demandé', () => {
    expect(appointmentWhere(TENANT, ALL, DAY, undefined)).toEqual({ tenantId: TENANT, deletedAt: null, startsAt: { gte: DAY.start, lt: DAY.end }, AND: [{}] });
    const restricted = appointmentWhere(TENANT, SITES, DAY, 's1');
    expect(restricted).toMatchObject({ siteId: 's1' });
    expect(restricted.AND).toEqual([{ OR: [{ siteId: { in: ['s1'] } }, { practitioner: { departmentId: { in: ['d1'] } } }] }]);
  });

  it('paymentWhere : succeeded, devise du tenant, journée, site de la facture', () => {
    expect(paymentWhere(TENANT, ALL, [], DAY, undefined, 'XOF')).toEqual({
      tenantId: TENANT,
      status: 'succeeded',
      currency: 'XOF',
      paidAt: { gte: DAY.start, lt: DAY.end },
      invoice: {},
    });
    expect(paymentWhere(TENANT, ALL, [], DAY, 's9', 'XOF').invoice).toEqual({ siteId: 's9' });
    expect(paymentWhere(TENANT, SITES, ['s2'], DAY, undefined, 'XOF').invoice).toEqual({ siteId: { in: ['s1', 's2'] } });
  });

  it('un site demandé hors portée ne couvre rien (liste de sites vide)', () => {
    expect(paymentWhere(TENANT, SITES, [], DAY, 's9', 'XOF').invoice).toEqual({ siteId: { in: [] } });
    expect(openSessionWhere(TENANT, SITES, [], 's9').register).toEqual({ siteId: { in: [] } });
  });

  it('openSessionWhere : sessions ouvertes du tenant, filtrées par site de la caisse', () => {
    expect(openSessionWhere(TENANT, ALL, [], undefined)).toEqual({ tenantId: TENANT, status: 'open', register: {} });
    expect(openSessionWhere(TENANT, SITES, [], 's1').register).toEqual({ siteId: 's1' });
  });
});
