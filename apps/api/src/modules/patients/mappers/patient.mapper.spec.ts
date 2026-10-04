import { describe, expect, it } from 'vitest';
import type { FieldCrypto } from '../../../common/crypto/field-crypto.service';
import { toDuplicateCandidate, toPatientDetail, toPatientSummary, type PatientRow } from './patient.mapper';

const TENANT = '11111111-1111-4111-8111-111111111111';

const crypto = {
  decryptOptional: (_tenant: string, blob: Uint8Array | null | undefined) => (blob ? `clair:${Buffer.from(blob).toString()}` : undefined),
} as unknown as FieldCrypto;

function row(overrides: Partial<PatientRow> = {}): PatientRow {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    tenantId: TENANT,
    ipp: 'P26-0000001',
    lastName: 'Diop',
    firstName: 'Awa',
    searchName: 'diop awa',
    birthDate: new Date('1990-05-17T00:00:00Z'),
    birthDateEstimated: false,
    sex: 'female',
    bloodGroup: 'O+',
    nationalIdEnc: new Uint8Array(Buffer.from('cni')),
    nationalIdBidx: new Uint8Array([1]),
    phoneEnc: new Uint8Array(Buffer.from('tel')),
    phoneBidx: new Uint8Array([2]),
    emailEnc: null,
    emailBidx: null,
    addressEnc: new Uint8Array(Buffer.from('adr')),
    city: 'Dakar',
    primarySiteId: null,
    keyVersion: 1,
    deceasedAt: null,
    mergedIntoPatientId: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-02T00:00:00Z'),
    createdBy: null,
    updatedBy: null,
    deletedAt: null,
    rowVersion: 3,
    ...overrides,
  } as PatientRow;
}

describe('toPatientSummary', () => {
  it('ne renvoie que les champs non sensibles de la liste', () => {
    const out = toPatientSummary(row());
    expect(Object.keys(out).sort()).toEqual(['birthDate', 'birthDateEstimated', 'city', 'firstName', 'id', 'ipp', 'lastName', 'sex']);
    expect(out.birthDate).toBe('1990-05-17');
  });

  it('renvoie une date de naissance nulle quand elle est inconnue', () => {
    expect(toPatientSummary(row({ birthDate: null })).birthDate).toBeNull();
  });
});

describe('toPatientDetail', () => {
  it('déchiffre les champs sensibles', () => {
    const out = toPatientDetail(row(), crypto);
    expect(out.phone).toBe('clair:tel');
    expect(out.nationalId).toBe('clair:cni');
    expect(out.address).toBe('clair:adr');
    expect(out.email).toBeNull();
  });

  it('ne laisse fuiter aucune colonne chiffrée ni index aveugle', () => {
    const serialized = JSON.stringify(toPatientDetail(row(), crypto));
    expect(serialized).not.toMatch(/_enc|_bidx|Enc|Bidx|searchName|keyVersion|deletedAt|tenantId/);
  });

  it('expose la version de ligne pour la concurrence optimiste', () => {
    expect(toPatientDetail(row(), crypto).rowVersion).toBe(3);
  });
});

describe('toPatientDetail : projection identité seule (A6)', () => {
  it('ne déchiffre ni ne renvoie téléphone, e-mail, pièce d’identité et adresse', () => {
    const out = toPatientDetail(row(), crypto, { includeContact: false });
    expect(out).toMatchObject({ phone: null, email: null, nationalId: null, address: null, lastName: 'Diop', city: 'Dakar', bloodGroup: 'O+' });
    expect(JSON.stringify(out)).not.toContain('clair:');
  });
});

describe('fiche : contactRedacted et deceasedAt (point 9)', () => {
  it('indique contactRedacted selon la projection', () => {
    expect(toPatientDetail(row(), crypto, { includeContact: true }).contactRedacted).toBe(false);
    expect(toPatientDetail(row(), crypto, { includeContact: false })).toMatchObject({ contactRedacted: true, phone: null });
  });

  it('expose deceasedAt en ISO, ou null', () => {
    expect(toPatientDetail(row({ deceasedAt: new Date('2027-01-02T10:00:00Z') }), crypto).deceasedAt).toBe('2027-01-02T10:00:00.000Z');
    expect(toPatientDetail(row({ deceasedAt: null }), crypto).deceasedAt).toBeNull();
  });
});

describe('toDuplicateCandidate (C3)', () => {
  it('ne renvoie que id, ipp, nom complet et année de naissance', () => {
    const out = toDuplicateCandidate(row());
    expect(out).toEqual({ id: '22222222-2222-4222-8222-222222222222', ipp: 'P26-0000001', fullName: 'Awa DIOP', birthYear: 1990 });
  });

  it('renvoie une année nulle sans date de naissance', () => {
    expect(toDuplicateCandidate(row({ birthDate: null })).birthYear).toBeNull();
  });
});
