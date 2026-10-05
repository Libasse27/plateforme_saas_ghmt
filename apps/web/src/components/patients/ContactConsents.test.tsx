import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toContactConsents } from '@/lib/domain/notifications';

const record = vi.fn();
vi.mock('@/actions/patient-consents', () => ({ recordConsentAction: (...args: unknown[]) => record(...args) }));

import { ContactConsents } from './ContactConsents';

const PATIENT = '3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
const VIEW = toContactConsents({
  patientId: PATIENT,
  current: [{ channel: 'sms', purpose: 'appointment_reminder', granted: true, source: 'front_desk', recordedAt: '2026-10-01T08:00:00.000Z' }],
  history: [
    { id: 'h2', channel: 'sms', granted: true, source: 'front_desk', recordedAt: '2026-10-01T08:00:00.000Z' },
    { id: 'h1', channel: 'sms', granted: false, source: 'sms_stop', recordedAt: '2026-09-01T08:00:00.000Z' },
  ],
});

beforeEach(() => record.mockReset().mockResolvedValue({ ok: true, message: 'Consentement SMS révoqué.' }));

describe('ContactConsents', () => {
  it('affiche l\'état de chaque canal : accordé, jamais recueilli', () => {
    render(<ContactConsents patientId={PATIENT} consents={VIEW} canUpdate timeZone="Africa/Dakar" />);
    expect(screen.getByRole('heading', { name: 'Rappels de rendez-vous' })).toBeInTheDocument();
    expect(screen.getByText('Accordé le 01/10/2026 08:00 (Accueil)')).toBeInTheDocument();
    expect(screen.getByText('Jamais recueilli')).toBeInTheDocument();
    expect(screen.getByText('Rappels autorisés')).toBeInTheDocument();
  });
  it('révoquer envoie le canal et granted=false, source côté serveur', async () => {
    render(<ContactConsents patientId={PATIENT} consents={VIEW} canUpdate timeZone="Africa/Dakar" />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Révoquer le consentement SMS' }));
    await waitFor(() => expect(record).toHaveBeenCalled());
    const data = record.mock.calls[0]?.[1] as FormData;
    expect(data.get('patientId')).toBe(PATIENT);
    expect(data.get('channel')).toBe('sms');
    expect(data.get('granted')).toBe('false');
    expect(data.get('source')).toBeNull();
  });
  it('accorder pour un canal sans consentement', async () => {
    render(<ContactConsents patientId={PATIENT} consents={VIEW} canUpdate timeZone="Africa/Dakar" />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Accorder le consentement E-mail' }));
    await waitFor(() => expect(record).toHaveBeenCalled());
    expect((record.mock.calls[0]?.[1] as FormData).get('granted')).toBe('true');
  });
  it('lecture seule : aucun bouton de modification', () => {
    render(<ContactConsents patientId={PATIENT} consents={VIEW} canUpdate={false} timeZone="Africa/Dakar" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
  it('historique replié, avec la source STOP', () => {
    render(<ContactConsents patientId={PATIENT} consents={VIEW} canUpdate={false} timeZone="Africa/Dakar" />);
    const summary = screen.getByText('Historique des consentements');
    expect(summary.closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText(/refusé le 01\/09\/2026 08:00 \(Réponse STOP par SMS\)/)).toBeInTheDocument();
  });
  it('pas d\'historique : pas de section dépliable', () => {
    render(<ContactConsents patientId={PATIENT} consents={toContactConsents(null)} canUpdate timeZone="Africa/Dakar" />);
    expect(screen.queryByText('Historique des consentements')).not.toBeInTheDocument();
  });
});
