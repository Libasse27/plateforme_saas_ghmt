import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecurityPolicyView, TrustedNetworkView } from '@/lib/domain/security';

const updatePolicy = vi.fn();
const addNetwork = vi.fn();
const removeNetwork = vi.fn();
const transfer = vi.fn();
vi.mock('@/actions/admin-security', () => ({
  updateSecurityPolicyAction: (...args: unknown[]) => updatePolicy(...args),
  addTrustedNetworkAction: (...args: unknown[]) => addNetwork(...args),
  removeTrustedNetworkAction: (...args: unknown[]) => removeNetwork(...args),
  transferOwnershipAction: (...args: unknown[]) => transfer(...args),
}));

import { OwnerTransferForm } from './OwnerTransferForm';
import { SecurityPolicyForm } from './SecurityPolicyForm';
import { TrustedNetworksPanel } from './TrustedNetworksPanel';

const NETWORK_ID = '0190c1a0-1111-7000-8000-000000000001';

const NETWORK: TrustedNetworkView = {
  id: NETWORK_ID,
  cidr: '203.0.113.0/24',
  label: 'Siège',
  createdAt: '2026-10-05T08:00:00.000Z',
  createdBy: { id: 'u1', fullName: 'Awa Diop' },
};

beforeEach(() => {
  for (const mock of [updatePolicy, addNetwork, removeNetwork, transfer]) mock.mockReset();
});

function panel(overrides: Partial<React.ComponentProps<typeof TrustedNetworksPanel>> = {}) {
  return render(
    <TrustedNetworksPanel networks={[NETWORK]} requestIp="198.51.100.7" requestIpTrusted={false} canUpdate timeZone="Africa/Dakar" {...overrides} />,
  );
}

describe('TrustedNetworksPanel', () => {
  it('affiche l\'adresse actuelle et si elle est de confiance', () => {
    panel();
    expect(screen.getByText(/Votre adresse actuelle : 198\.51\.100\.7/)).toHaveTextContent('réseau de confiance : non');
    panel({ requestIp: '203.0.113.9', requestIpTrusted: true });
    expect(screen.getAllByText(/Votre adresse actuelle : 203\.0\.113\.9/)[0]).toHaveTextContent('réseau de confiance : oui');
  });

  it('adresse inconnue : le dit, sans bouton « Ajouter ce réseau »', () => {
    panel({ requestIp: null });
    expect(screen.getByText(/Votre adresse actuelle n'est pas connue/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Ajouter ce réseau/ })).not.toBeInTheDocument();
  });

  it('liste les plages avec leur libellé et leur auteur, sans colonne de site (décision 26)', () => {
    panel();
    const table = screen.getByRole('table', { name: /Plages réseau de confiance/ });
    const row = within(table).getByText('203.0.113.0/24').closest('tr') as HTMLElement;
    expect(row).toHaveTextContent('Siège');
    expect(row).toHaveTextContent('Awa Diop');
    expect(within(table).queryByRole('columnheader', { name: 'Site' })).not.toBeInTheDocument();
  });

  it('aucune plage : explique que tous les réseaux sont hors confiance', () => {
    panel({ networks: [] });
    expect(screen.getByText(/tous les réseaux sont hors confiance/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('avertit des adresses 4G (CGNAT) et dynamiques', () => {
    panel();
    expect(screen.getByRole('note', { name: /Attention aux adresses partagées ou instables/ })).toHaveTextContent('CGNAT');
  });

  it('sans droit de modification : lecture seule, aucun formulaire ni bouton de suppression', () => {
    panel({ canUpdate: false });
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Plage réseau/)).not.toBeInTheDocument();
    expect(screen.getByText(/Lecture seule/)).toBeInTheDocument();
  });

  it('« Ajouter ce réseau (/32) » envoie l\'indicateur d\'adresse actuelle et le libellé, jamais l\'adresse', async () => {
    addNetwork.mockResolvedValue({ ok: true, message: 'Plage réseau ajoutée.' });
    const user = userEvent.setup();
    panel();
    const form = screen.getByRole('button', { name: 'Ajouter ce réseau (/32)' }).closest('form') as HTMLFormElement;
    await user.clear(within(form).getByLabelText(/Libellé/));
    await user.type(within(form).getByLabelText(/Libellé/), 'Mon poste');
    await user.click(within(form).getByRole('button', { name: 'Ajouter ce réseau (/32)' }));
    const data = addNetwork.mock.calls[0]?.[1] as FormData;
    expect(data.get('useCurrentIp')).toBe('1');
    expect(data.get('label')).toBe('Mon poste');
    expect(data.get('cidr')).toBeNull();
  });

  it('IPv6 : le bouton annonce /128', () => {
    panel({ requestIp: '2001:db8::1' });
    expect(screen.getByRole('button', { name: 'Ajouter ce réseau (/128)' })).toBeInTheDocument();
  });

  it('IPv4 encapsulée : le bouton annonce /32', () => {
    panel({ requestIp: '::ffff:198.51.100.7' });
    expect(screen.getByRole('button', { name: 'Ajouter ce réseau (/32)' })).toBeInTheDocument();
  });

  it('le formulaire d\'ajout envoie la plage et le libellé, sans champ de site', async () => {
    addNetwork.mockResolvedValue({});
    const user = userEvent.setup();
    panel({ requestIp: null });
    await user.type(screen.getByLabelText(/Plage réseau/), '10.20.0.0/16');
    await user.type(screen.getByLabelText(/^Libellé/), 'LAN clinique');
    expect(screen.queryByLabelText(/Site/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Ajouter la plage' }));
    const data = addNetwork.mock.calls[0]?.[1] as FormData;
    expect(data.get('cidr')).toBe('10.20.0.0/16');
    expect(data.get('label')).toBe('LAN clinique');
    expect(data.get('siteId')).toBeNull();
  });

  it('affiche l\'erreur de champ du serveur (plage trop large)', async () => {
    addNetwork.mockResolvedValue({ ok: false, message: 'Certains champs sont invalides.', fieldErrors: { cidr: 'Plage trop large.' } });
    const user = userEvent.setup();
    panel({ requestIp: null });
    await user.click(screen.getByRole('button', { name: 'Ajouter la plage' }));
    expect(await screen.findByLabelText(/Plage réseau/)).toHaveAccessibleDescription(expect.stringContaining('Plage trop large.'));
  });

  it('la suppression exige une confirmation et envoie l\'identifiant de la plage', async () => {
    removeNetwork.mockResolvedValue({ ok: true, message: 'Plage réseau supprimée.' });
    const user = userEvent.setup();
    panel();
    await user.click(screen.getByText('Supprimer'));
    expect(screen.getByText(/Les soignants connectés depuis cette plage devront utiliser le second facteur/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirmer la suppression' }));
    expect((removeNetwork.mock.calls[0]?.[1] as FormData).get('networkId')).toBe(NETWORK_ID);
  });
});

const POLICY: Pick<SecurityPolicyView, 'clinicalMfa'> = { clinicalMfa: 'off_network' };

describe('SecurityPolicyForm', () => {
  it('propose exactement deux modes, le mode courant coché', () => {
    render(<SecurityPolicyForm policy={POLICY} canUpdate />);
    const group = screen.getByRole('group', { name: /Second facteur des soignants/ });
    expect(within(group).getAllByRole('radio')).toHaveLength(2);
    expect(within(group).getByRole('radio', { name: /Hors du réseau de l'établissement seulement/ })).toBeChecked();
    expect(within(group).getByRole('radio', { name: /Toujours/ })).not.toBeChecked();
  });

  it('enregistre le mode choisi', async () => {
    updatePolicy.mockResolvedValue({ ok: true, message: 'Politique d\'authentification enregistrée.' });
    const user = userEvent.setup();
    render(<SecurityPolicyForm policy={POLICY} canUpdate />);
    await user.click(screen.getByRole('radio', { name: /Toujours/ }));
    await user.click(screen.getByRole('button', { name: 'Enregistrer la politique' }));
    expect((updatePolicy.mock.calls[0]?.[1] as FormData).get('clinicalMfa')).toBe('always');
    expect(await screen.findByRole('status')).toHaveTextContent('enregistrée');
  });

  it('lecture seule sans iam:policy:update : texte du mode courant, aucun champ', () => {
    render(<SecurityPolicyForm policy={{ clinicalMfa: 'always' }} canUpdate={false} />);
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(/Toujours, même depuis le réseau de l'établissement/)).toBeInTheDocument();
  });
});

describe('OwnerTransferForm', () => {
  const CANDIDATES = [
    { id: '0190c1a0-3333-7000-8000-000000000003', fullName: 'Moussa Ndiaye', email: 'moussa@clinique.sn' },
    { id: '0190c1a0-4444-7000-8000-000000000004', fullName: 'Fatou Sow', email: 'fatou@clinique.sn' },
  ];

  it('propose les utilisateurs candidats et demande une confirmation avant le transfert', async () => {
    transfer.mockResolvedValue({ ok: true, message: 'Le titre d\'administrateur principal a été transféré.' });
    const user = userEvent.setup();
    render(<OwnerTransferForm candidates={CANDIDATES} />);
    await user.click(screen.getByText('Transférer le titre'));
    expect(screen.getByText(/Vous perdrez le titre/)).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText(/Nouvel administrateur principal/), CANDIDATES[1]?.id ?? '');
    await user.click(screen.getByRole('button', { name: 'Confirmer le transfert' }));
    expect((transfer.mock.calls[0]?.[1] as FormData).get('userId')).toBe(CANDIDATES[1]?.id);
  });

  it('sans candidat : explique pourquoi et ne propose pas de formulaire', () => {
    render(<OwnerTransferForm candidates={[]} />);
    expect(screen.getByText(/Aucun autre utilisateur actif/)).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('affiche l\'erreur de l\'API (cible sans second facteur)', async () => {
    transfer.mockResolvedValue({ ok: false, message: 'Le nouvel administrateur principal doit être un autre administrateur actif de l\'établissement, avec un second facteur activé.' });
    const user = userEvent.setup();
    render(<OwnerTransferForm candidates={CANDIDATES} />);
    await user.click(screen.getByText('Transférer le titre'));
    await user.selectOptions(screen.getByLabelText(/Nouvel administrateur principal/), CANDIDATES[0]?.id ?? '');
    await user.click(screen.getByRole('button', { name: 'Confirmer le transfert' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('second facteur');
  });
});
