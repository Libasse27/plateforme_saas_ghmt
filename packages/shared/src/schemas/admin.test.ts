import { describe, expect, it } from 'vitest';
import {
  AUDIT_EXPORT_MAX_ROWS,
  AUDIT_OUTCOMES,
  auditLogFiltersSchema,
  dashboardQuerySchema,
  exportAuditLogsSchema,
  listAuditLogsQuerySchema,
  verifyAuditChainQuerySchema,
} from './admin';

const UUID = '018f0000-0000-7000-8000-000000000001';

describe('constantes', () => {
  it('expose les résultats d’audit et le plafond d’export du contrat', () => {
    expect(AUDIT_OUTCOMES).toEqual(['success', 'denied', 'failure']);
    expect(AUDIT_EXPORT_MAX_ROWS).toBe(10000);
  });
});

describe('auditLogFiltersSchema', () => {
  it('accepte un objet vide (tous les filtres sont optionnels)', () => {
    expect(auditLogFiltersSchema.parse({})).toEqual({});
  });

  it('accepte tous les filtres valides', () => {
    const input = {
      from: '2026-10-01T00:00:00Z',
      to: '2026-10-05T00:00:00Z',
      actorUserId: UUID,
      action: 'patient.created',
      resourceType: 'patient',
      resourceId: UUID,
      outcome: 'denied',
    };
    expect(auditLogFiltersSchema.parse(input)).toEqual(input);
  });

  it.each(['patient.*', 'audit.logs_read', 'a'])('accepte l’action « %s » (exacte ou préfixe)', (action) => {
    expect(auditLogFiltersSchema.safeParse({ action }).success).toBe(true);
  });

  it.each(['Patient.created', 'patient..created', '.patient', 'patient.*.x', "a'; DROP", 'patient created', '*', ''])(
    'refuse l’action « %s »',
    (action) => {
      expect(auditLogFiltersSchema.safeParse({ action }).success).toBe(false);
    },
  );

  it('refuse un type de ressource hors motif, un résultat inconnu, un uuid mal formé et une date non ISO', () => {
    expect(auditLogFiltersSchema.safeParse({ resourceType: 'Patient' }).success).toBe(false);
    expect(auditLogFiltersSchema.safeParse({ resourceType: 'a'.repeat(51) }).success).toBe(false);
    expect(auditLogFiltersSchema.safeParse({ outcome: 'ok' }).success).toBe(false);
    expect(auditLogFiltersSchema.safeParse({ actorUserId: 'abc' }).success).toBe(false);
    expect(auditLogFiltersSchema.safeParse({ resourceId: 'abc' }).success).toBe(false);
    expect(auditLogFiltersSchema.safeParse({ from: 'hier' }).success).toBe(false);
  });

  it('refuse une période inversée', () => {
    const result = auditLogFiltersSchema.safeParse({ from: '2026-10-05T00:00:00Z', to: '2026-10-01T00:00:00Z' });
    expect(result.success).toBe(false);
  });
});

describe('listAuditLogsQuerySchema', () => {
  it('applique la limite par défaut de 50 et convertit la chaîne de requête', () => {
    expect(listAuditLogsQuerySchema.parse({}).limit).toBe(50);
    expect(listAuditLogsQuerySchema.parse({ limit: '100' }).limit).toBe(100);
  });

  it.each(['0', '101', '1.5', 'x'])('refuse la limite « %s »', (limit) => {
    expect(listAuditLogsQuerySchema.safeParse({ limit }).success).toBe(false);
  });

  it('transmet le curseur et les filtres, et refuse une période inversée', () => {
    expect(listAuditLogsQuerySchema.parse({ cursor: 'MTI', action: 'iam.*' })).toMatchObject({ cursor: 'MTI', action: 'iam.*' });
    expect(listAuditLogsQuerySchema.safeParse({ from: '2026-10-05T00:00:00Z', to: '2026-10-01T00:00:00Z' }).success).toBe(false);
  });
});

describe('exportAuditLogsSchema', () => {
  it('accepte les filtres seuls et ignore les champs inconnus', () => {
    const parsed = exportAuditLogsSchema.parse({ action: 'audit.*', limit: 5, extra: 'x' });
    expect(parsed).toEqual({ action: 'audit.*' });
  });
});

describe('verifyAuditChainQuerySchema', () => {
  it('vaut 50000 par défaut et borne la limite entre 1000 et 50000', () => {
    expect(verifyAuditChainQuerySchema.parse({}).limit).toBe(50000);
    expect(verifyAuditChainQuerySchema.parse({ limit: '1000' }).limit).toBe(1000);
    expect(verifyAuditChainQuerySchema.safeParse({ limit: '999' }).success).toBe(false);
    expect(verifyAuditChainQuerySchema.safeParse({ limit: '50001' }).success).toBe(false);
  });
});

describe('dashboardQuerySchema', () => {
  it('accepte un siteId uuid optionnel et refuse le reste', () => {
    expect(dashboardQuerySchema.parse({})).toEqual({});
    expect(dashboardQuerySchema.parse({ siteId: UUID })).toEqual({ siteId: UUID });
    expect(dashboardQuerySchema.safeParse({ siteId: 'x' }).success).toBe(false);
  });
});
