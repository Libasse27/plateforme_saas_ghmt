import { addAssignmentAction } from '@/actions/admin-users';
import { ActionForm } from '@/components/forms/ActionForm';
import { SCOPE_TYPE_LABELS } from '@/lib/domain/admin';

interface Option {
  readonly id: string;
  readonly name: string;
}

export interface ScopeOptions {
  readonly roles: readonly Option[];
  readonly sites: readonly Option[];
  readonly departments: readonly Option[];
}

/** Champs de rôle et de portée (établissement, site ou service) partagés entre l'invitation et l'affectation. */
export function scopeFields(options: ScopeOptions, roleRequired: boolean) {
  return [
    { kind: 'select', name: 'roleId', label: 'Rôle', required: roleRequired, placeholder: roleRequired ? 'Choisir un rôle…' : 'Aucun rôle pour l\'instant', options: options.roles.map((r) => ({ value: r.id, label: r.name })) },
    { kind: 'select', name: 'scopeType', label: 'Portée', defaultValue: 'tenant', options: Object.entries(SCOPE_TYPE_LABELS).map(([value, label]) => ({ value, label })) },
    { kind: 'select', name: 'siteId', label: 'Site (si la portée est un site)', placeholder: 'Aucun', options: options.sites.map((s) => ({ value: s.id, label: s.name })) },
    { kind: 'select', name: 'departmentId', label: 'Service (si la portée est un service)', placeholder: 'Aucun', options: options.departments.map((d) => ({ value: d.id, label: d.name })) },
  ] as const;
}

export function AssignmentForm({ userId, options }: { readonly userId: string; readonly options: ScopeOptions }) {
  return (
    <ActionForm
      action={addAssignmentAction}
      idPrefix="assign-"
      hidden={{ userId }}
      fields={[...scopeFields(options, true), { kind: 'date', name: 'validUntil', label: 'Valable jusqu\'au (facultatif)', hint: 'Fin de validité incluse, au format AAAA-MM-JJ.' }]}
      submitLabel="Ajouter l'affectation"
      pendingLabel="Ajout…"
    />
  );
}
