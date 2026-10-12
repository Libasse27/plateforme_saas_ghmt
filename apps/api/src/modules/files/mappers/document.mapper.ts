import type { AllowedUploadType, PatientDocumentView } from '@ghmt/shared';
import type { FieldCrypto } from '../../../common/crypto/field-crypto.service';
import type { FileRow } from '../repositories/files.repository';

/** Vue d'un document (docs/13 §5) : nom d'origine déchiffré, jamais la clé d'objet ni la clé de données. */
export function toPatientDocumentView(row: FileRow, crypto: FieldCrypto, userNames: ReadonlyMap<string, string>): PatientDocumentView {
  return {
    id: row.id,
    purpose: row.purpose,
    status: row.status === 'available' ? 'available' : 'pending',
    originalName: crypto.decrypt(row.tenantId, row.originalName),
    mimeType: row.mimeType as AllowedUploadType,
    sizeBytes: Number(row.sizeBytes),
    createdAt: row.createdAt.toISOString(),
    createdBy: { id: row.createdBy, fullName: userNames.get(row.createdBy) ?? '' },
  };
}
