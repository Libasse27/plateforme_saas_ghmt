import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_UPLOAD_BYTES, type PatientDocumentView } from '@ghmt/shared';

const upload = vi.fn();
const remove = vi.fn();
vi.mock('@/actions/patient-documents', () => ({
  uploadDocumentAction: (...args: unknown[]) => upload(...args),
  deleteDocumentAction: (...args: unknown[]) => remove(...args),
}));

import { PatientDocuments } from './PatientDocuments';

const PATIENT = '3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
const AVAILABLE: PatientDocumentView = {
  id: '0192f0a0-0000-7000-8000-000000000001',
  purpose: 'identity',
  status: 'available',
  originalName: 'Carte d’identité.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 2048,
  createdAt: '2026-10-11T10:00:00.000Z',
  createdBy: { id: '0192f0a0-0000-7000-8000-000000000002', fullName: 'Awa Diop' },
};
const PENDING: PatientDocumentView = { ...AVAILABLE, id: '0192f0a0-0000-7000-8000-000000000003', status: 'pending', originalName: 'Mutuelle.jpg', mimeType: 'image/jpeg', purpose: 'insurance_card' };

const renderBlock = (props: Partial<Parameters<typeof PatientDocuments>[0]> = {}) =>
  render(<PatientDocuments patientId={PATIENT} documents={[AVAILABLE, PENDING]} canCreate canDelete timeZone="Africa/Dakar" {...props} />);

beforeEach(() => {
  upload.mockReset().mockResolvedValue({ ok: true, message: 'Document déposé.' });
  remove.mockReset().mockResolvedValue({ ok: true, message: 'Document supprimé.' });
});

describe('PatientDocuments (bloc « Documents » de la fiche patient)', () => {
  it('liste les documents : usage, nom, taille, date, auteur, et un lien BFF de téléchargement', () => {
    renderBlock();

    expect(screen.getByRole('heading', { name: 'Documents' })).toBeInTheDocument();
    const row = screen.getByText('Carte d’identité.pdf').closest('li')!;
    expect(within(row).getByText('Pièce d’identité')).toBeInTheDocument();
    expect(within(row).getByText(/2 Ko · 11\/10\/2026 10:00 · Awa Diop/)).toBeInTheDocument();
    expect(within(row).getByRole('link', { name: 'Télécharger Carte d’identité.pdf' })).toHaveAttribute(
      'href',
      `/patients/${PATIENT}/documents/${AVAILABLE.id}/contenu`,
    );
  });

  it('avertit quand certains documents ne peuvent pas être affichés, sinon reste silencieux', () => {
    const { rerender } = renderBlock({ skippedDocuments: 2 });

    expect(screen.getByText('Certains documents ne peuvent pas être affichés.')).toBeInTheDocument();
    rerender(<PatientDocuments patientId={PATIENT} documents={[AVAILABLE]} canCreate canDelete timeZone="Africa/Dakar" />);
    expect(screen.queryByText('Certains documents ne peuvent pas être affichés.')).not.toBeInTheDocument();
  });

  it('affiche « Analyse en cours » sans lien de téléchargement pour un document en attente', () => {
    renderBlock();

    const row = screen.getByText('Mutuelle.jpg').closest('li')!;
    expect(within(row).getByText('Analyse en cours')).toBeInTheDocument();
    expect(within(row).queryByRole('link')).not.toBeInTheDocument();
  });

  it('indique l’absence de document', () => {
    renderBlock({ documents: [] });

    expect(screen.getByText('Aucun document déposé.')).toBeInTheDocument();
  });

  it('lecture seule : ni dépôt ni suppression', () => {
    renderBlock({ canCreate: false, canDelete: false });

    expect(screen.queryByLabelText('Fichier')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('dépose un fichier avec son usage par l’action serveur', async () => {
    renderBlock({ canDelete: false });
    const user = userEvent.setup();
    const file = new File(['%PDF-1.7'], 'scan.pdf', { type: 'application/pdf' });

    await user.selectOptions(screen.getByLabelText(/Type de document/), 'insurance_card');
    const input = screen.getByLabelText('Fichier') as HTMLInputElement;
    await user.upload(input, file);
    await user.click(screen.getByRole('button', { name: 'Déposer le document' }));

    await waitFor(() => expect(upload).toHaveBeenCalled());
    const data = upload.mock.calls[0]?.[1] as FormData;
    expect(data.get('patientId')).toBe(PATIENT);
    expect(data.get('purpose')).toBe('insurance_card');
    // jsdom ne reporte pas le fichier sélectionné dans FormData : on vérifie le champ lui-même (nom `file`).
    expect(data.has('file')).toBe(true);
    expect([input.name, input.files?.[0]?.name]).toEqual(['file', 'scan.pdf']);
    expect(await screen.findByText('Document déposé.')).toBeInTheDocument();
  });

  it('refuse côté navigateur un fichier de plus de 10 Mo, sans appel au serveur', async () => {
    renderBlock({ canDelete: false });
    const big = new File(['x'], 'gros.pdf', { type: 'application/pdf' });
    Object.defineProperty(big, 'size', { value: MAX_UPLOAD_BYTES + 1 });

    fireEvent.change(screen.getByLabelText('Fichier'), { target: { files: [big] } });

    expect(await screen.findByText('Fichier trop volumineux (10 Mo au plus)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Déposer le document' })).toBeDisabled();
    expect(upload).not.toHaveBeenCalled();
  });

  it('affiche le message d’erreur renvoyé par le serveur', async () => {
    upload.mockResolvedValue({ ok: false, message: 'Fichier refusé par l’analyse antivirus' });
    renderBlock({ canDelete: false });
    const user = userEvent.setup();

    await user.upload(screen.getByLabelText('Fichier'), new File(['x'], 'eicar.pdf', { type: 'application/pdf' }));
    await user.click(screen.getByRole('button', { name: 'Déposer le document' }));

    expect(await screen.findByText('Fichier refusé par l’analyse antivirus')).toBeInTheDocument();
  });

  it('supprime un document avec un motif', async () => {
    renderBlock({ canCreate: false });
    const user = userEvent.setup();
    const row = screen.getByText('Carte d’identité.pdf').closest('li')!;

    await user.click(within(row).getByText('Supprimer'));
    await user.type(within(row).getByLabelText('Motif de la suppression'), 'Pièce périmée');
    await user.click(within(row).getByRole('button', { name: 'Supprimer Carte d’identité.pdf' }));

    await waitFor(() => expect(remove).toHaveBeenCalled());
    const data = remove.mock.calls[0]?.[1] as FormData;
    expect(data.get('documentId')).toBe(AVAILABLE.id);
    expect(data.get('patientId')).toBe(PATIENT);
    expect(data.get('reason')).toBe('Pièce périmée');
  });
});
