import type { AuditLogView } from '@ghmt/shared';
import { describe, expect, it } from 'vitest';
import { AUDIT_CSV_HEADER, auditCsvFilename, buildAuditCsv, csvCell } from './audit-csv';

const BOM = '﻿';

function row(overrides: Partial<AuditLogView> = {}): AuditLogView {
  return {
    id: 'id-1',
    seq: '12',
    occurredAt: '2026-10-05T10:00:00.000Z',
    actor: { type: 'user', userId: 'u-1', fullName: 'Awa Diop' },
    action: 'patient.created',
    resourceType: 'patient',
    resourceId: 'r-1',
    patientId: 'p-1',
    outcome: 'success',
    ip: '10.0.0.1',
    requestId: 'req-1',
    changes: { a: 1 },
    ...overrides,
  };
}

describe('csvCell', () => {
  it('rend une cellule vide pour null et undefined', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });

  it('laisse intacte une valeur simple', () => {
    expect(csvCell('abc')).toBe('abc');
  });

  it('met entre guillemets (doublés) les valeurs contenant ; " ou un saut de ligne', () => {
    expect(csvCell('a;b')).toBe('"a;b"');
    expect(csvCell('dit "oui"')).toBe('"dit ""oui"""');
    expect(csvCell('l1\nl2')).toBe('"l1\nl2"');
  });

  it.each(['=1+1', '+33', '-2', '@SUM(A1)', '\tx', '\rx'])('préfixe d’une apostrophe la cellule « %j » (injection de formule)', (value) => {
    const cell = csvCell(value);

    expect(cell.replace(/^"/, '').startsWith("'")).toBe(true);
  });

  it('protège aussi une formule contenant des séparateurs, en conservant les guillemets', () => {
    expect(csvCell('=HYPERLINK("http://x";"y")')).toBe('"\'=HYPERLINK(""http://x"";""y"")"');
  });

  it('ne préfixe pas une valeur dont le premier caractère est sûr', () => {
    expect(csvCell('a=b')).toBe('a=b');
    expect(csvCell('1-2')).toBe('1-2');
  });
});

describe('buildAuditCsv', () => {
  it('commence par le BOM UTF-8 puis l’en-tête du contrat, séparateur « ; »', () => {
    const csv = buildAuditCsv([]);

    expect(csv.startsWith(BOM)).toBe(true);
    expect(csv.slice(1)).toBe(`${AUDIT_CSV_HEADER}\r\n`);
    expect(AUDIT_CSV_HEADER).toBe(
      'seq;horodatage_utc;type_acteur;id_acteur;nom_acteur;action;type_ressource;id_ressource;id_patient;resultat;ip;id_requete;details_json',
    );
  });

  it('écrit une ligne par événement, dans l’ordre des colonnes, avec details_json sérialisé', () => {
    const csv = buildAuditCsv([row()]);
    const lines = csv.slice(1).split('\r\n');

    expect(lines[1]).toBe('12;2026-10-05T10:00:00.000Z;user;u-1;Awa Diop;patient.created;patient;r-1;p-1;success;10.0.0.1;req-1;"{""a"":1}"');
  });

  it('met entre guillemets le JSON (qui contient des guillemets) lorsque nécessaire', () => {
    const csv = buildAuditCsv([row({ changes: { k: 'v;w' } })]);

    expect(csv).toContain('"{""k"":""v;w""}"');
  });

  it('laisse vides les champs absents et neutralise un nom d’acteur piégé', () => {
    const csv = buildAuditCsv([row({ actor: { type: 'system', userId: null, fullName: '=cmd|x' }, resourceType: null, resourceId: null, patientId: null, ip: null, requestId: null, changes: null })]);
    const line = csv.slice(1).split('\r\n')[1]!;

    expect(line).toBe("12;2026-10-05T10:00:00.000Z;system;;'=cmd|x;patient.created;;;;success;;;");
  });
});

describe('auditCsvFilename', () => {
  it('formate les bornes UTC en AAAAMMJJ', () => {
    expect(auditCsvFilename(new Date('2026-09-28T23:59:59Z'), new Date('2026-10-05T08:00:00Z'))).toBe('journal-audit-20260928-20261005.csv');
  });
});
