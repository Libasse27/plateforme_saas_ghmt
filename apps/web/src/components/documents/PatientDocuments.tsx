import type { PatientDocumentView } from '@ghmt/shared';
import { deleteDocumentAction } from '@/actions/patient-documents';
import { ActionForm } from '@/components/forms/ActionForm';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { DOCUMENT_MESSAGES, PURPOSE_LABELS, documentContentHref, formatFileSize } from '@/lib/documents/documents';
import { formatDateTime } from '@/lib/format/dates';
import { DocumentUploadForm } from './DocumentUploadForm';

export interface PatientDocumentsProps {
  readonly patientId: string;
  readonly documents: readonly PatientDocumentView[];
  /** Éléments de la liste écartés faute de respecter le schéma (voir `toPatientDocuments`). */
  readonly skippedDocuments?: number;
  readonly canCreate: boolean;
  readonly canDelete: boolean;
  readonly timeZone: string;
}

function DocumentRow({ patientId, document, canDelete, timeZone }: { readonly patientId: string; readonly document: PatientDocumentView; readonly canDelete: boolean; readonly timeZone: string }) {
  const available = document.status === 'available';
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 py-3">
      <div>
        <p className="text-sm text-slate-700">{PURPOSE_LABELS[document.purpose]}</p>
        <p className="font-medium">{document.originalName}</p>
        <p className="text-sm text-slate-800">
          {formatFileSize(document.sizeBytes)} · {formatDateTime(document.createdAt, timeZone)} · {document.createdBy.fullName || '-'}
        </p>
        {available ? null : <Badge tone="warning">Analyse en cours</Badge>}
      </div>
      <div className="flex flex-col items-end gap-2">
        {available ? (
          <a href={documentContentHref(patientId, document.id)} className="font-semibold text-blue-800 underline" aria-label={`Télécharger ${document.originalName}`}>
            Télécharger
          </a>
        ) : null}
        {canDelete ? (
          <details>
            <summary className="cursor-pointer text-sm font-medium text-red-800 underline">Supprimer</summary>
            <ActionForm
              action={deleteDocumentAction}
              fields={[{ kind: 'textarea', name: 'reason', label: 'Motif de la suppression', required: true, rows: 2, maxLength: 500 }]}
              hidden={{ patientId, documentId: document.id }}
              submitLabel={`Supprimer ${document.originalName}`}
              pendingLabel="Suppression…"
              variant="danger"
              idPrefix={`doc-${document.id}-`}
            />
          </details>
        ) : null}
      </div>
    </li>
  );
}

/**
 * Bloc « Documents » de la fiche patient (docs/13 §9) : pièces d'identité, cartes d'assurance et justificatifs. Le
 * téléchargement passe par le BFF ; un document en cours d'analyse antivirus n'est jamais téléchargeable.
 */
export function PatientDocuments({ patientId, documents, skippedDocuments = 0, canCreate, canDelete, timeZone }: PatientDocumentsProps) {
  return (
    <section aria-labelledby="documents-patient" className="mt-6 rounded-md border border-slate-300 bg-white p-4">
      <h2 id="documents-patient" className="text-lg font-semibold">Documents</h2>
      {skippedDocuments > 0 ? (
        <div className="mt-2">
          <Alert tone="warning">{DOCUMENT_MESSAGES.some_unreadable}</Alert>
        </div>
      ) : null}
      {documents.length === 0 ? (
        <p className="mt-2 text-sm text-slate-800">Aucun document déposé.</p>
      ) : (
        <ul className="divide-y divide-slate-200">
          {documents.map((document) => (
            <DocumentRow key={document.id} patientId={patientId} document={document} canDelete={canDelete} timeZone={timeZone} />
          ))}
        </ul>
      )}
      {canCreate ? <DocumentUploadForm patientId={patientId} /> : null}
    </section>
  );
}
