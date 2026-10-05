import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InAppMessageView, NotificationPreferenceView } from '@/lib/domain/notifications';

const markRead = vi.fn();
const markAll = vi.fn();
const updatePreferences = vi.fn();
vi.mock('@/actions/notifications', () => ({
  markReadAction: (...args: unknown[]) => markRead(...args),
  markAllReadAction: (...args: unknown[]) => markAll(...args),
  updatePreferencesAction: (...args: unknown[]) => updatePreferences(...args),
}));

import { InboxList } from './InboxList';
import { PreferencesForm } from './PreferencesForm';

const MESSAGES: InAppMessageView[] = [
  { id: 'm1', typeCode: 'subscription.payment_overdue', title: 'Facture en retard', body: 'La facture GHMT-1 est en retard.', link: '/abonnement', createdAt: '2026-10-05T10:00:00.000Z', readAt: null },
  { id: 'm2', typeCode: 'quota.sms_threshold', title: 'Quota SMS à 80 %', body: 'Seuil atteint.', link: null, createdAt: '2026-10-04T09:30:00.000Z', readAt: '2026-10-04T10:00:00.000Z' },
];

beforeEach(() => {
  markRead.mockReset().mockResolvedValue({ ok: true, message: 'ok' });
  markAll.mockReset().mockResolvedValue({ ok: true, message: 'ok' });
  updatePreferences.mockReset().mockResolvedValue({ ok: true, message: 'Préférences enregistrées.' });
});

describe('InboxList', () => {
  it('liste les messages, marque les non lus et propose le lien interne', () => {
    render(<InboxList messages={MESSAGES} timeZone="Africa/Dakar" unreadOnly={false} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('Non lu')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Ouvrir/ })).toHaveAttribute('href', '/abonnement');
    expect(screen.getAllByRole('button', { name: 'Marquer comme lu' })).toHaveLength(1);
    expect(screen.getByText('05/10/2026 10:00')).toBeInTheDocument();
  });
  it('marquer comme lu envoie l\'identifiant du message', async () => {
    render(<InboxList messages={MESSAGES} timeZone="Africa/Dakar" unreadOnly={false} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Marquer comme lu' }));
    await waitFor(() => expect(markRead).toHaveBeenCalled());
    expect((markRead.mock.calls[0]?.[1] as FormData).get('id')).toBe('m1');
  });
  it('états vides distincts selon le filtre', () => {
    const { rerender } = render(<InboxList messages={[]} timeZone="Africa/Dakar" unreadOnly={false} />);
    expect(screen.getByText('Aucune notification pour le moment.')).toBeInTheDocument();
    rerender(<InboxList messages={[]} timeZone="Africa/Dakar" unreadOnly />);
    expect(screen.getByText('Aucune notification non lue.')).toBeInTheDocument();
  });
});

const PREFS: NotificationPreferenceView[] = [
  { category: 'administrative', channel: 'inapp', enabled: true, locked: true, note: null },
  { category: 'administrative', channel: 'email', enabled: true, locked: false, note: 'Les relances de facturation restent envoyées aux administrateurs.' },
];

describe('PreferencesForm', () => {
  it('désactive et coche une préférence verrouillée, affiche la note de la modifiable', () => {
    render(<PreferencesForm preferences={PREFS} />);
    const inapp = screen.getByLabelText(/Dans l'application/);
    expect(inapp).toBeDisabled();
    expect(inapp).toBeChecked();
    expect(screen.getByText(/Verrouillée/)).toBeInTheDocument();
    const email = screen.getByLabelText(/E-mail/);
    expect(email).toBeEnabled();
    expect(email).toHaveAccessibleDescription(/relances de facturation/);
  });
  it('soumet les clés modifiables et l\'état des cases', async () => {
    const user = userEvent.setup();
    render(<PreferencesForm preferences={PREFS} />);
    await user.click(screen.getByLabelText(/E-mail/));
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(updatePreferences).toHaveBeenCalled());
    const data = updatePreferences.mock.calls[0]?.[1] as FormData;
    expect(data.get('known')).toBe('administrative:email');
    expect(data.get('pref.administrative:email')).toBeNull();
    expect(await screen.findByRole('status')).toHaveTextContent('Préférences enregistrées.');
  });
  it('sans préférence modifiable : pas de bouton ; liste vide : message', () => {
    const { rerender } = render(<PreferencesForm preferences={[PREFS[0] as NotificationPreferenceView]} />);
    expect(screen.queryByRole('button', { name: 'Enregistrer' })).not.toBeInTheDocument();
    rerender(<PreferencesForm preferences={[]} />);
    expect(screen.getByText('Aucune préférence configurable.')).toBeInTheDocument();
  });
});
