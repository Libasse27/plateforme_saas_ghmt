import { describe, expect, it } from 'vitest';
import {
  ALLOWED_UPLOAD_TYPES,
  MAX_UPLOAD_BYTES,
  deleteDocumentSchema,
  filePurposeSchema,
  fileStatusSchema,
  patientDocumentViewSchema,
} from './index';

const VIEW = {
  id: '0192f0a0-0000-7000-8000-000000000001',
  purpose: 'identity',
  status: 'available',
  originalName: 'Carte d’identité.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 1024,
  createdAt: '2026-10-11T10:00:00.000Z',
  createdBy: { id: '0192f0a0-0000-7000-8000-000000000002', fullName: 'Awa Diop' },
};

describe('schémas des documents (docs/13 §7)', () => {
  it('expose les constantes du contrat', () => {
    expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
    expect(ALLOWED_UPLOAD_TYPES).toEqual(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
  });

  it('accepte les trois usages administratifs et refuse les autres', () => {
    expect(filePurposeSchema.options).toEqual(['identity', 'insurance_card', 'administrative']);
    expect(filePurposeSchema.safeParse('clinical_report').success).toBe(false);
  });

  it('énumère les statuts de fichier', () => {
    expect(fileStatusSchema.options).toEqual(['pending', 'available', 'rejected', 'deleted']);
  });

  it('valide une vue de document ; seuls les statuts « available » et « pending » sont exposés', () => {
    expect(patientDocumentViewSchema.parse(VIEW)).toEqual(VIEW);
    expect(patientDocumentViewSchema.safeParse({ ...VIEW, status: 'pending' }).success).toBe(true);
    expect(patientDocumentViewSchema.safeParse({ ...VIEW, status: 'rejected' }).success).toBe(false);
    expect(patientDocumentViewSchema.safeParse({ ...VIEW, mimeType: 'text/html' }).success).toBe(false);
    expect(patientDocumentViewSchema.safeParse({ ...VIEW, sizeBytes: MAX_UPLOAD_BYTES + 1 }).success).toBe(false);
  });

  it('exige un motif de suppression de 5 à 500 caractères (espaces de bord retirés)', () => {
    expect(deleteDocumentSchema.parse({ reason: '  Doublon du dépôt  ' })).toEqual({ reason: 'Doublon du dépôt' });
    expect(deleteDocumentSchema.safeParse({ reason: 'abc ' }).success).toBe(false);
    expect(deleteDocumentSchema.safeParse({ reason: 'x'.repeat(501) }).success).toBe(false);
    expect(deleteDocumentSchema.safeParse({}).success).toBe(false);
  });
});
