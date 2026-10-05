import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPermissionMatrix, toPermissionGroups, type DepartmentView, type SiteAdminView, type UserSummaryView } from '@/lib/domain/admin';

const mocks = vi.hoisted(() => ({
  disable: vi.fn(), enable: vi.fn(), resend: vi.fn(), unlock: vi.fn(), revoke: vi.fn(), addAssignment: vi.fn(),
  createSite: vi.fn(), createDepartment: vi.fn(), createPractitioner: vi.fn(), updatePractitioner: vi.fn(),
  verify: vi.fn(), createRole: vi.fn(), updateRole: vi.fn(),
}));
vi.mock('@/actions/admin-users', () => ({
  disableUserAction: mocks.disable, enableUserAction: mocks.enable, resendInvitationAction: mocks.resend,
  unlockUserAction: mocks.unlock, revokeSessionsAction: mocks.revoke, addAssignmentAction: mocks.addAssignment,
}));
vi.mock('@/actions/admin-org', () => ({ createSiteAction: mocks.createSite, createDepartmentAction: mocks.createDepartment }));
vi.mock('@/actions/admin-practitioners', () => ({ createPractitionerAction: mocks.createPractitioner, updatePractitionerAction: mocks.updatePractitioner }));
vi.mock('@/actions/admin-audit', () => ({ verifyAuditChainAction: mocks.verify }));
vi.mock('@/actions/admin-roles', () => ({ createRoleAction: mocks.createRole, updateRoleAction: mocks.updateRole, deleteRoleAction: vi.fn() }));

import { AssignmentForm } from './AssignmentForm';
import { AuditFilters } from './AuditFilters';
import { ConfirmAction } from './ConfirmAction';
import { DepartmentsPanel } from './DepartmentsPanel';
import { IntegrityCheck } from './IntegrityCheck';
import { PractitionerForm } from './PractitionerForm';
import { RoleEditor } from './RoleEditor';
import { SitesPanel } from './SitesPanel';
import { UserActions } from './UserActions';
import { UsersTable } from './UsersTable';

const ALL = { update: true, create: true, revokeSessions: true };
const USER = '3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab';

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset().mockResolvedValue({ ok: true, message: 'Fait.' });
});

describe('UserActions', () => {
  it('compte actif : désactiver et révoquer les sessions en deux temps', async () => {
    render(<UserActions userId={USER} status="active" rights={ALL} />);
    expect(screen.getByText('Désactiver le compte')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Réactiver le compte' })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Confirmer la désactivation' }));
    await waitFor(() => expect(mocks.disable).toHaveBeenCalled());
    expect((mocks.disable.mock.calls[0]?.[1] as FormData).get('userId')).toBe(USER);
  });
  it('compte invité : renvoyer l\'invitation directement', async () => {
    render(<UserActions userId={USER} status="invited" rights={ALL} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Renvoyer l\'invitation' }));
    await waitFor(() => expect(mocks.resend).toHaveBeenCalled());
  });
  it('compte verrouillé : déverrouiller ; désactivé : réactiver', async () => {
    const { rerender } = render(<UserActions userId={USER} status="locked" rights={ALL} />);
    expect(screen.getByRole('button', { name: 'Déverrouiller le compte' })).toBeInTheDocument();
    rerender(<UserActions userId={USER} status="disabled" rights={ALL} />);
    expect(screen.getByRole('button', { name: 'Réactiver le compte' })).toBeInTheDocument();
  });
  it('sans permission : aucune action rendue', () => {
    const { container } = render(<UserActions userId={USER} status="active" rights={{ update: false, create: false, revokeSessions: false }} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('ConfirmAction', () => {
  it('affiche l\'avertissement et envoie les champs cachés', async () => {
    const action = vi.fn().mockResolvedValue({ ok: true, message: 'Supprimé.' });
    render(<ConfirmAction action={action} hidden={{ id: 'x1' }} summary="Supprimer" confirmLabel="Confirmer" warning="Irréversible." idPrefix="del-" />);
    expect(screen.getByText('Irréversible.')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Confirmer' }));
    await waitFor(() => expect(action).toHaveBeenCalled());
    expect((action.mock.calls[0]?.[1] as FormData).get('id')).toBe('x1');
  });
});

describe('AssignmentForm', () => {
  it('propose rôles, portées, sites et services puis soumet le formulaire', async () => {
    const options = { roles: [{ id: 'r1', name: 'Médecin' }], sites: [{ id: 's1', name: 'Dakar' }], departments: [{ id: 'd1', name: 'Pédiatrie' }] };
    const user = userEvent.setup();
    render(<AssignmentForm userId={USER} options={options} />);
    await user.selectOptions(screen.getByLabelText(/Rôle/), 'r1');
    await user.selectOptions(screen.getByLabelText('Portée'), 'site');
    await user.selectOptions(screen.getByLabelText(/Site \(si/), 's1');
    await user.click(screen.getByRole('button', { name: 'Ajouter l\'affectation' }));
    await waitFor(() => expect(mocks.addAssignment).toHaveBeenCalled());
    const data = mocks.addAssignment.mock.calls[0]?.[1] as FormData;
    expect(data.get('roleId')).toBe('r1');
    expect(data.get('scopeType')).toBe('site');
    expect(data.get('siteId')).toBe('s1');
    expect(data.get('userId')).toBe(USER);
    expect(screen.getByLabelText(/Service \(si/)).toBeInTheDocument();
  });
});

const user = (overrides: Partial<UserSummaryView> = {}): UserSummaryView => ({ id: USER, email: 'awa@clinique.sn', fullName: 'Awa Diop', status: 'active', locale: 'fr', mustChangePassword: false, lastLoginAt: null, ...overrides });

describe('UsersTable', () => {
  it('liste les utilisateurs avec un lien vers la fiche, sans donnée patient', () => {
    render(<UsersTable users={[user(), user({ id: 'u2', fullName: 'Ibou Fall', status: 'locked', lastLoginAt: '2026-10-05T10:00:00.000Z' })]} timeZone="Africa/Dakar" />);
    expect(screen.getByRole('link', { name: 'Awa Diop' })).toHaveAttribute('href', `/administration/utilisateurs/${USER}`);
    expect(screen.getByText('Verrouillé')).toBeInTheDocument();
    expect(screen.getByText('Jamais')).toBeInTheDocument();
    expect(screen.getByText('05/10/2026 10:00')).toBeInTheDocument();
  });
  it('état vide', () => {
    render(<UsersTable users={[]} timeZone="Africa/Dakar" />);
    expect(screen.getByText('Aucun utilisateur ne correspond à ces critères.')).toBeInTheDocument();
  });
});

const SITES: SiteAdminView[] = [{ id: 's1', code: 'DK', name: 'Dakar', city: 'Dakar', countryCode: 'SN', timezone: 'Africa/Dakar', isMain: true }];
const DEPARTMENTS: DepartmentView[] = [{ id: 'd1', siteId: 's1', parentId: null, code: 'MG', name: 'Médecine', kind: 'clinical' }];

describe('SitesPanel et DepartmentsPanel', () => {
  it('sites : badge principal, lien de modification et création selon les droits', () => {
    const { rerender } = render(<SitesPanel sites={SITES} canCreate canEdit defaultTimezone="Africa/Dakar" defaultCountry="SN" />);
    expect(screen.getByText('Principal')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Modifier/ })).toHaveAttribute('href', '/administration/organisation/sites/s1');
    expect(screen.getByRole('button', { name: 'Créer le site' })).toBeInTheDocument();
    rerender(<SitesPanel sites={SITES} canCreate={false} canEdit={false} defaultTimezone="Africa/Dakar" defaultCountry="SN" />);
    expect(screen.queryByRole('link', { name: /Modifier/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Créer le site' })).not.toBeInTheDocument();
    rerender(<SitesPanel sites={[]} canCreate={false} canEdit={false} defaultTimezone="" defaultCountry="" />);
    expect(screen.getByText('Aucun site.')).toBeInTheDocument();
  });
  it('services : regroupés par site, création conditionnée', () => {
    const { rerender } = render(<DepartmentsPanel sites={SITES} departments={DEPARTMENTS} canCreate canEdit />);
    expect(screen.getByRole('heading', { name: 'Dakar' })).toBeInTheDocument();
    expect(screen.getByText('Médecine')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Modifier/ })).toHaveAttribute('href', '/administration/organisation/services/d1');
    expect(screen.getByRole('button', { name: 'Créer le service' })).toBeInTheDocument();
    rerender(<DepartmentsPanel sites={SITES} departments={[]} canCreate={false} canEdit={false} />);
    expect(screen.getByText('Aucun service.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Créer le service' })).not.toBeInTheDocument();
  });
});

describe('PractitionerForm', () => {
  const options = { departments: [{ id: 'd1', name: 'Médecine' }], sites: [{ id: 's1', name: 'Dakar' }] };
  it('création : utilisateur lié proposé seulement s\'il est fourni', () => {
    const { rerender } = render(<PractitionerForm {...options} users={[{ id: 'u1', name: 'Awa Diop' }]} />);
    expect(screen.getByLabelText(/Utilisateur lié/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Créer le praticien' })).toBeInTheDocument();
    rerender(<PractitionerForm {...options} />);
    expect(screen.queryByLabelText(/Utilisateur lié/)).not.toBeInTheDocument();
  });
  it('modification : valeurs préremplies et identifiant caché', async () => {
    const practitioner = { id: 'p1', userId: null, fullName: 'Dr Awa', specialty: 'Pédiatrie', departmentId: 'd1', primarySiteId: 's1', licenseNumber: 'L1', defaultConsultMinutes: 30, isBookable: false };
    render(<PractitionerForm {...options} practitioner={practitioner} />);
    expect(screen.getByLabelText(/Nom complet/)).toHaveValue('Dr Awa');
    expect(screen.getByLabelText(/Durée de consultation/)).toHaveValue(30);
    expect(screen.getByLabelText(/Réservable/)).not.toBeChecked();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(mocks.updatePractitioner).toHaveBeenCalled());
    expect((mocks.updatePractitioner.mock.calls[0]?.[1] as FormData).get('id')).toBe('p1');
  });
});

describe('AuditFilters', () => {
  it('formulaire GET sans champ de recherche de patient, export POST si autorisé', () => {
    const { container } = render(<AuditFilters filters={{ from: '2026-10-01', action: 'auth.*', outcome: 'denied' }} canExport />);
    const get = container.querySelector('form[method="get"]') as HTMLFormElement;
    expect(get).toHaveAttribute('action', '/administration/journal');
    expect(screen.getByLabelText('Du')).toHaveValue('2026-10-01');
    expect(screen.getByLabelText('Résultat')).toHaveValue('denied');
    expect(screen.getByLabelText(/^Action/)).toHaveValue('auth.*');
    expect(screen.queryByLabelText(/patient/i)).not.toBeInTheDocument();
    const post = container.querySelector('form[method="post"]') as HTMLFormElement;
    expect(post).toHaveAttribute('action', '/administration/journal/export');
    expect(post.querySelector('input[name="action"]')).toHaveValue('auth.*');
    expect(post.querySelector('input[name="du"]')).toHaveValue('2026-10-01');
    expect(post.querySelector('input[name="au"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Exporter en CSV' })).toBeInTheDocument();
  });
  it('pas de bouton d\'export sans la permission', () => {
    render(<AuditFilters filters={{}} canExport={false} />);
    expect(screen.queryByRole('button', { name: 'Exporter en CSV' })).not.toBeInTheDocument();
  });
});

describe('IntegrityCheck', () => {
  it('lance la vérification et annonce le résultat', async () => {
    mocks.verify.mockResolvedValue({ ok: true, message: 'Journal intègre : 12 maillons vérifiés.' });
    render(<IntegrityCheck />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Vérifier l\'intégrité' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Journal intègre');
  });
  it('rupture : alerte', async () => {
    mocks.verify.mockResolvedValue({ ok: false, message: 'Chaîne rompue au maillon 9.' });
    render(<IntegrityCheck />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Vérifier l\'intégrité' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Chaîne rompue');
  });
});

describe('RoleEditor', () => {
  const matrix = buildPermissionMatrix(toPermissionGroups([{ module: 'patients', name: 'Patients', permissions: [{ code: 'patients:patient:read', resource: 'patient', action: 'read', isSensitive: false }] }]));
  it('création : code, nom et matrice', async () => {
    const user = userEvent.setup();
    render(<RoleEditor matrix={matrix} held={['patients:*:*']} />);
    await user.type(screen.getByLabelText(/Code/), 'role_test');
    await user.type(screen.getByLabelText(/^Nom/), 'Rôle test');
    await user.click(screen.getByRole('checkbox', { name: /Lire/ }));
    await user.click(screen.getByRole('button', { name: 'Créer le rôle' }));
    await waitFor(() => expect(mocks.createRole).toHaveBeenCalled());
    const data = mocks.createRole.mock.calls[0]?.[1] as FormData;
    expect(data.get('code')).toBe('role_test');
    expect(data.getAll('permissions')).toEqual(['patients:patient:read']);
  });
  it('modification : champs préremplis, pas de code, identifiant caché', async () => {
    const role = { id: 'r1', code: 'custom', name: 'Infirmier chef', description: 'Desc', isSystem: false, mfaRequired: false, permissionCount: 1, permissions: ['patients:patient:read'] };
    render(<RoleEditor role={role} matrix={matrix} held={['patients:*:*']} />);
    expect(screen.queryByLabelText(/^Code/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^Nom/)).toHaveValue('Infirmier chef');
    expect(screen.getByRole('checkbox', { name: /Lire/ })).toBeChecked();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Enregistrer le rôle' }));
    await waitFor(() => expect(mocks.updateRole).toHaveBeenCalled());
    expect((mocks.updateRole.mock.calls[0]?.[1] as FormData).get('id')).toBe('r1');
  });
  it('affiche les erreurs de champ renvoyées', async () => {
    mocks.createRole.mockResolvedValue({ ok: false, message: 'Certains champs sont invalides.', fieldErrors: { code: 'Code déjà utilisé.', permissions: 'Permission refusée.' }, values: { code: 'x' } });
    render(<RoleEditor matrix={matrix} held={[]} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Créer le rôle' }));
    expect(await screen.findByText('Code déjà utilisé.')).toBeInTheDocument();
    expect(screen.getByText('Permission refusée.')).toBeInTheDocument();
  });
});
