import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { buildPermissionMatrix, toDashboard, toPermissionGroups } from '@/lib/domain/admin';
import type { AuditLogView } from '@/lib/domain/audit';

vi.mock('@/actions/admin-roles', () => ({ createRoleAction: vi.fn(), updateRoleAction: vi.fn(), deleteRoleAction: vi.fn() }));
vi.mock('@/actions/admin-audit', () => ({ verifyAuditChainAction: vi.fn() }));

import { AuditTable } from './AuditTable';
import { DashboardCards } from './DashboardCards';
import { RoleMatrix } from './RoleMatrix';

const MATRIX = buildPermissionMatrix(
  toPermissionGroups([
    { module: 'patients', name: 'Patients', permissions: [
      { code: 'patients:patient:read', resource: 'patient', action: 'read', isSensitive: false },
      { code: 'patients:patient:delete', resource: 'patient', action: 'delete', isSensitive: true },
    ] },
  ]),
);

describe('RoleMatrix', () => {
  it('coche les permissions du rôle et désactive celles que le lecteur ne détient pas', () => {
    render(<RoleMatrix matrix={MATRIX} selected={['patients:patient:read']} held={['patients:patient:read']} />);
    const read = screen.getByRole('checkbox', { name: /Patients.*patient.*Lire/ });
    const del = screen.getByRole('checkbox', { name: /Patients.*patient.*Supprimer/ });
    expect(read).toBeEnabled();
    expect(read).toBeChecked();
    expect(del).toBeDisabled();
    expect(del).not.toBeChecked();
  });
  it('conserve une permission cochée mais non détenue (champ caché) pour ne pas la retirer à l\'enregistrement', () => {
    const { container } = render(
      <form>
        <RoleMatrix matrix={MATRIX} selected={['patients:patient:delete']} held={[]} />
      </form>,
    );
    const hidden = container.querySelector('input[type="hidden"][name="permissions"]');
    expect(hidden).toHaveValue('patients:patient:delete');
  });
  it('les motifs génériques détenus (patients:*:*) activent les cases', () => {
    render(<RoleMatrix matrix={MATRIX} selected={[]} held={['patients:*:*']} />);
    expect(screen.getByRole('checkbox', { name: /Supprimer/ })).toBeEnabled();
  });
  it('rôle système : lecture seule, tout désactivé et rien à soumettre', () => {
    const { container } = render(<RoleMatrix matrix={MATRIX} selected={['patients:patient:read']} held={['patients:*:*']} readOnly />);
    for (const box of screen.getAllByRole('checkbox')) expect(box).toBeDisabled();
    expect(container.querySelector('input[type="hidden"]')).toBeNull();
    expect(screen.getByRole('checkbox', { name: /Lire/ })).toBeChecked();
  });
  it('marque les permissions sensibles et les cellules sans permission', () => {
    render(<RoleMatrix matrix={MATRIX} selected={[]} held={['patients:*:*']} />);
    expect(screen.getByText('sensible')).toBeInTheDocument();
  });
  it('catalogue vide : message', () => {
    render(<RoleMatrix matrix={[]} selected={[]} held={[]} />);
    expect(screen.getByText('Catalogue de permissions indisponible.')).toBeInTheDocument();
  });
  it('permet de cocher une case', async () => {
    render(<RoleMatrix matrix={MATRIX} selected={[]} held={['patients:*:*']} />);
    const box = screen.getByRole('checkbox', { name: /Lire/ });
    await userEvent.setup().click(box);
    expect(box).toBeChecked();
  });
});

const LOG: AuditLogView = {
  id: 'a1', seq: '42', occurredAt: '2026-10-05T10:00:00.000Z',
  actor: { type: 'user', userId: 'u1', fullName: 'Awa Diop' },
  action: 'patient.updated', resourceType: 'patient', resourceId: 'r1', patientId: null,
  outcome: 'denied', ip: '10.0.0.1', requestId: 'req-1', changes: { status: 'x', note: '[masqué]' },
};

describe('AuditTable', () => {
  it('affiche la ligne et un détail dépliable des changements', () => {
    render(<AuditTable logs={[LOG, { ...LOG, id: 'a2', seq: '41', actor: { type: 'system', userId: null, fullName: null }, changes: null, outcome: 'success' }]} timeZone="Africa/Dakar" />);
    expect(screen.getByRole('table', { name: /Journal d'audit/ })).toBeInTheDocument();
    expect(screen.getByText('Awa Diop')).toBeInTheDocument();
    expect(screen.getByText('Système')).toBeInTheDocument();
    expect(screen.getByText('Refusé')).toBeInTheDocument();
    const details = screen.getAllByText('Détails', { selector: 'summary' });
    expect(details).toHaveLength(2);
    const first = details[0]?.closest('details') as HTMLElement;
    expect(within(first).getByText(/"status": "x"/)).toBeInTheDocument();
    expect(within(first).getByText(/req-1/)).toBeInTheDocument();
  });
  it('état vide', () => {
    render(<AuditTable logs={[]} timeZone="Africa/Dakar" />);
    expect(screen.getByText('Aucun événement pour ces filtres.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('DashboardCards', () => {
  const full = toDashboard({
    date: '2026-10-05', timezone: 'Africa/Dakar',
    patients: { total: 120, registeredToday: 3 },
    appointments: { total: 9, byStatus: { scheduled: 4, confirmed: 3, cancelled: 2 } },
    revenue: { currency: 'XOF', total: '45000', byMethod: { cash: '30000', mobile_money: '15000' } },
    cashSessions: { openCount: 1, items: [{ id: 'c1', registerCode: 'C1', siteId: 's1', openedAt: '2026-10-05T07:00:00.000Z', openedBy: { id: 'u1', fullName: 'Awa Diop' } }] },
  });
  it('affiche chaque carte', () => {
    render(<DashboardCards dashboard={full} timeZone="Africa/Dakar" />);
    expect(screen.getByRole('heading', { name: 'Patients' })).toBeInTheDocument();
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Rendez-vous du jour' })).toBeInTheDocument();
    expect(screen.getByText('Confirmé')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Recettes du jour' })).toBeInTheDocument();
    expect(screen.getByText('Espèces')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Sessions de caisse ouvertes' })).toBeInTheDocument();
    expect(screen.getByText(/C1/)).toBeInTheDocument();
  });
  it('masque les sections absentes', () => {
    render(<DashboardCards dashboard={toDashboard({ date: '2026-10-05', patients: { total: 5, registeredToday: 0 } })} timeZone="Africa/Dakar" />);
    expect(screen.getByRole('heading', { name: 'Patients' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Recettes du jour' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Sessions de caisse ouvertes' })).not.toBeInTheDocument();
  });
  it('aucune section accessible : message', () => {
    render(<DashboardCards dashboard={toDashboard({ date: '2026-10-05' })} timeZone="Africa/Dakar" />);
    expect(screen.getByText(/Aucune donnée n'est accessible avec vos droits/)).toBeInTheDocument();
  });
  it('aucune session ouverte', () => {
    render(<DashboardCards dashboard={toDashboard({ date: '2026-10-05', cashSessions: { openCount: 0, items: [] } })} timeZone="Africa/Dakar" />);
    expect(screen.getByText('Aucune session ouverte.')).toBeInTheDocument();
  });
});
