import { describe, expect, it } from 'vitest';
import {
  AUDIT_FILTER_PARAMS,
  auditApiQuery,
  auditExportFilters,
  auditHref,
  exportFailureHref,
  exportFailureKey,
  exportFailureMessage,
  exportHeaders,
  isSameOrigin,
  isSameOriginRequest,
  OUTCOME_LABELS,
  parseAuditFilters,
  toAuditLog,
  toChainVerification,
  verificationMessage,
} from './audit';

const TZ = 'Africa/Dakar';
const UUID = '0190c1a0-1111-7000-8000-000000000001';

describe('toAuditLog', () => {
  it('lit une ligne complète', () => {
    const view = toAuditLog({
      id: 'a1', seq: '42', occurredAt: '2026-10-05T10:00:00.000Z',
      actor: { type: 'user', userId: UUID, fullName: 'Awa Diop' },
      action: 'patient.updated', resourceType: 'patient', resourceId: UUID, patientId: UUID,
      outcome: 'success', ip: '10.0.0.1', requestId: 'r1', changes: { status: 'x' },
    });
    expect(view).toMatchObject({ id: 'a1', seq: '42', actor: { type: 'user', userId: UUID, fullName: 'Awa Diop' }, outcome: 'success', changes: { status: 'x' } });
  });
  it('tolère le vide, un résultat inconnu et des changements non objets', () => {
    const view = toAuditLog({ outcome: 'weird', changes: 'texte', actor: null });
    expect(view).toMatchObject({ seq: '', action: '', outcome: 'unknown', changes: null, actor: { type: 'system', userId: null, fullName: null } });
    expect(toAuditLog({ changes: [1] }).changes).toBeNull();
    expect(toAuditLog(undefined).resourceType).toBeNull();
  });
  it('libellés des résultats', () => {
    expect(OUTCOME_LABELS.denied).toBe('Refusé');
  });
});

describe('filtres du journal : liste blanche', () => {
  it('ne retient que les paramètres connus et valides', () => {
    const filters = parseAuditFilters({
      du: '2026-10-01', au: '2026-10-05', acteur: UUID, action: 'patient.*', ressource: 'patient', idRessource: UUID, resultat: 'denied',
      apres: 'MTIz', q: 'Awa', patient: 'Awa DIOP', nom: 'x',
    });
    expect(filters).toEqual({ from: '2026-10-01', to: '2026-10-05', actor: UUID, action: 'patient.*', resourceType: 'patient', resourceId: UUID, outcome: 'denied' });
    expect(Object.keys(filters).sort()).toEqual(['action', 'actor', 'from', 'outcome', 'resourceId', 'resourceType', 'to']);
  });
  it('écarte les valeurs invalides', () => {
    expect(parseAuditFilters({ du: '05/10/2026', au: '2026-13-40', acteur: 'awa', action: 'Patient Search', ressource: 'x y', idRessource: '1', resultat: 'ok' })).toEqual({});
    expect(parseAuditFilters({})).toEqual({});
  });
  it('la liste blanche des paramètres d\'URL est figée', () => {
    expect([...AUDIT_FILTER_PARAMS].sort()).toEqual(['acteur', 'action', 'apres', 'au', 'du', 'idRessource', 'ressource', 'resultat']);
  });
});

describe('requête API du journal', () => {
  it('convertit les jours en bornes ISO du fuseau et ajoute limite et curseur', () => {
    const query = auditApiQuery({ from: '2026-10-01', to: '2026-10-05', outcome: 'success', action: 'auth.*' }, TZ, { limit: 25, cursor: 'MTIz' });
    expect(query).toEqual({
      from: '2026-10-01T00:00:00.000Z', to: '2026-10-06T00:00:00.000Z', outcome: 'success', action: 'auth.*', limit: 25, cursor: 'MTIz',
    });
  });
  it('omet les champs vides et un curseur invalide', () => {
    expect(auditApiQuery({}, TZ, { limit: 50, cursor: '../x' })).toEqual({ limit: 50 });
  });
  it('n\'envoie aucun champ hors liste blanche', () => {
    const query = auditApiQuery({ actor: UUID, resourceType: 'patient', resourceId: UUID }, TZ, { limit: 50 });
    expect(Object.keys(query).sort()).toEqual(['actorUserId', 'limit', 'resourceId', 'resourceType']);
  });
  it('filtres d\'export à partir des champs du formulaire POST', () => {
    const body = auditExportFilters({ du: '2026-10-01', au: '2026-10-05', acteur: UUID, action: 'x_y.z', ressource: 'patient', secret: 'x' }, TZ);
    expect(body).toEqual({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-06T00:00:00.000Z', actorUserId: UUID, action: 'x_y.z', resourceType: 'patient' });
  });
});

describe('liens de pagination', () => {
  it('reconstruit une URL avec dates, codes et uuid seulement', () => {
    expect(auditHref({ from: '2026-10-01', action: 'auth.*', outcome: 'failure' }, 'MTIz')).toBe('/administration/journal?du=2026-10-01&action=auth.*&resultat=failure&apres=MTIz');
    expect(auditHref({}, null)).toBe('/administration/journal');
  });
});

describe('vérification d\'intégrité', () => {
  it('lit le résultat', () => {
    const view = toChainVerification({ status: 'intact', checkedCount: 1200, fromSeq: '1', toSeq: '1200', firstBrokenSeq: null, checkedAt: '2026-10-05T10:00:00.000Z' });
    expect(view).toMatchObject({ status: 'intact', checkedCount: 1200, fromSeq: '1', toSeq: '1200', firstBrokenSeq: null });
    expect(verificationMessage(view)).toContain('intègre');
    expect(verificationMessage(view)).toContain('1200');
  });
  it('rupture et vide', () => {
    const broken = toChainVerification({ status: 'broken', checkedCount: 10, fromSeq: '5', toSeq: '14', firstBrokenSeq: '9' });
    expect(verificationMessage(broken)).toContain('rompue');
    expect(verificationMessage(broken)).toContain('9');
    expect(verificationMessage(toChainVerification({ status: 'empty' }))).toContain('vide');
    expect(verificationMessage(toChainVerification(null))).toContain('indéterminé');
  });
});

describe('export CSV : contrôle d\'origine', () => {
  it('accepte une origine identique à l\'hôte', () => {
    expect(isSameOrigin('https://app.ghmt.sn', 'app.ghmt.sn')).toBe(true);
    expect(isSameOrigin('http://localhost:3001', 'localhost:3001')).toBe(true);
  });
  it('refuse origine étrangère, absente ou mal formée', () => {
    expect(isSameOrigin('https://evil.test', 'app.ghmt.sn')).toBe(false);
    expect(isSameOrigin('https://app.ghmt.sn.evil.test', 'app.ghmt.sn')).toBe(false);
    expect(isSameOrigin(null, 'app.ghmt.sn')).toBe(false);
    expect(isSameOrigin('null', 'app.ghmt.sn')).toBe(false);
    expect(isSameOrigin('https://app.ghmt.sn', null)).toBe(false);
  });
  it('Fetch Metadata prioritaire : seul same-origin passe, quelle que soit l\'origine', () => {
    const headers = (h: Record<string, string>) => new Headers({ host: 'app.ghmt.sn', ...h });
    expect(isSameOriginRequest(headers({ 'sec-fetch-site': 'same-origin', origin: 'null' }))).toBe(true);
    expect(isSameOriginRequest(headers({ 'sec-fetch-site': 'same-origin' }))).toBe(true);
    expect(isSameOriginRequest(headers({ 'sec-fetch-site': 'same-site', origin: 'https://app.ghmt.sn' }))).toBe(false);
    expect(isSameOriginRequest(headers({ 'sec-fetch-site': 'cross-site', origin: 'https://app.ghmt.sn' }))).toBe(false);
    expect(isSameOriginRequest(headers({ 'sec-fetch-site': 'none' }))).toBe(false);
  });
  it('sans Fetch Metadata : repli sur Origin comparé à l\'hôte (x-forwarded-host prioritaire)', () => {
    expect(isSameOriginRequest(new Headers({ host: 'app.ghmt.sn', origin: 'https://app.ghmt.sn' }))).toBe(true);
    expect(isSameOriginRequest(new Headers({ host: 'internal:3001', 'x-forwarded-host': 'app.ghmt.sn', origin: 'https://app.ghmt.sn' }))).toBe(true);
    expect(isSameOriginRequest(new Headers({ host: 'app.ghmt.sn', origin: 'null' }))).toBe(false);
    expect(isSameOriginRequest(new Headers({ host: 'app.ghmt.sn' }))).toBe(false);
  });
  it('transmet type et nom de fichier, impose no-store et nosniff', () => {
    const headers = exportHeaders(new Headers({ 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="journal-audit-20261001-20261005.csv"', 'set-cookie': 'x=1' }));
    expect(headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(headers.get('content-disposition')).toBe('attachment; filename="journal-audit-20261001-20261005.csv"');
    expect(headers.get('cache-control')).toBe('no-store');
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('set-cookie')).toBeNull();
  });
  it('remplace un nom de fichier suspect', () => {
    const headers = exportHeaders(new Headers({ 'content-disposition': 'inline; filename="../../x.html"' }));
    expect(headers.get('content-disposition')).toBe('attachment; filename="journal-audit.csv"');
    expect(headers.get('content-type')).toBe('text/csv; charset=utf-8');
  });
});

describe('échec d\'export : retour sur le journal avec un message', () => {
  it('classe les erreurs de l\'API en clés fermées', () => {
    expect(exportFailureKey({ status: 422, code: 'export_too_large' })).toBe('trop-volumineux');
    expect(exportFailureKey({ status: 403, code: 'subscription_grace' })).toBe('abonnement');
    expect(exportFailureKey({ status: 429, code: 'throttled' })).toBe('limite');
    expect(exportFailureKey({ status: 403, code: 'permission_denied' })).toBe('interdit');
    expect(exportFailureKey({ status: 422, code: 'range_too_large' })).toBe('periode');
    expect(exportFailureKey({ status: 500, code: 'x' })).toBe('erreur');
  });
  it('messages français, inconnu ignoré', () => {
    expect(exportFailureMessage('trop-volumineux')).toContain('10 000');
    expect(exportFailureMessage('limite')).toContain('Trop de tentatives');
    expect(exportFailureMessage('abonnement')).toContain('grâce');
    expect(exportFailureMessage('interdit')).toContain('autorisation');
    expect(exportFailureMessage('periode')).toContain('période');
    expect(exportFailureMessage('erreur')).toContain('export');
    expect(exportFailureMessage('<script>')).toBeNull();
    expect(exportFailureMessage(undefined)).toBeNull();
  });
  it('lien de retour : filtres conservés, clé ajoutée', () => {
    expect(exportFailureHref({ from: '2026-10-01', outcome: 'denied' }, 'limite')).toBe('/administration/journal?du=2026-10-01&resultat=denied&export=limite');
    expect(exportFailureHref({}, 'erreur')).toBe('/administration/journal?export=erreur');
  });
});
