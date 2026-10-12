'use client';

import { useActionState, useState, type ChangeEvent } from 'react';
import { uploadDocumentAction } from '@/actions/patient-documents';
import { SelectField } from '@/components/ui/Field';
import { FormMessage } from '@/components/ui/FormMessage';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { inputClass } from '@/components/ui/styles';
import { PURPOSE_LABELS, UPLOAD_ACCEPT, checkUploadFile } from '@/lib/documents/documents';
import { EMPTY_FORM_STATE } from '@/lib/forms';

const PURPOSE_OPTIONS = Object.entries(PURPOSE_LABELS).map(([value, label]) => ({ value, label }));

/** Dépôt d'un document : taille contrôlée dans le navigateur avant envoi (le BFF et l'API la contrôlent aussi). */
export function DocumentUploadForm({ patientId }: { readonly patientId: string }) {
  const [state, formAction] = useActionState(uploadDocumentAction, EMPTY_FORM_STATE);
  const [fileError, setFileError] = useState<string | null>(null);

  const onFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const file = event.currentTarget.files?.[0];
    setFileError(file ? checkUploadFile(file) : null);
  };

  return (
    <form action={formAction} className="mt-4 space-y-3 border-t border-slate-200 pt-4" noValidate>
      <h3 className="font-semibold">Déposer un document</h3>
      <FormMessage state={state} />
      <input type="hidden" name="patientId" value={patientId} />
      <SelectField name="purpose" label="Type de document" options={PURPOSE_OPTIONS} defaultValue="identity" required />
      <div className="space-y-1">
        <label htmlFor="document-file" className="block text-sm font-medium text-slate-900">Fichier</label>
        <input
          id="document-file"
          type="file"
          name="file"
          accept={UPLOAD_ACCEPT}
          required
          onChange={onFileChange}
          aria-invalid={fileError ? true : undefined}
          aria-describedby="document-file-hint"
          className={inputClass}
        />
        <p id="document-file-hint" className="text-sm text-slate-700">PDF, JPEG, PNG ou WebP, 10 Mo au plus. Les métadonnées des photos sont retirées.</p>
        {fileError ? <p className="text-sm font-medium text-red-700" role="alert">{fileError}</p> : null}
      </div>
      <SubmitButton pendingLabel="Dépôt et analyse en cours…" disabled={fileError !== null}>Déposer le document</SubmitButton>
    </form>
  );
}
