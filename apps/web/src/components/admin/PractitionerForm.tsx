import { createPractitionerAction, updatePractitionerAction } from '@/actions/admin-practitioners';
import { ActionForm, type FieldSpec } from '@/components/forms/ActionForm';
import type { PractitionerAdminView } from '@/lib/domain/admin';

interface Option {
  readonly id: string;
  readonly name: string;
}

export interface PractitionerFormProps {
  readonly practitioner?: PractitionerAdminView;
  readonly departments: readonly Option[];
  readonly sites: readonly Option[];
  /** Utilisateurs liés possibles : fournis seulement avec `iam:user:read`, et uniquement à la création. */
  readonly users?: readonly Option[];
}

function fieldsFor({ practitioner, departments, sites, users }: PractitionerFormProps): FieldSpec[] {
  const fields: FieldSpec[] = [
    { kind: 'text', name: 'fullName', label: 'Nom complet', required: true, defaultValue: practitioner?.fullName ?? '' },
    { kind: 'text', name: 'specialty', label: 'Spécialité', defaultValue: practitioner?.specialty ?? '' },
    { kind: 'select', name: 'departmentId', label: 'Service', placeholder: 'Aucun', defaultValue: practitioner?.departmentId ?? '', options: departments.map((d) => ({ value: d.id, label: d.name })) },
    { kind: 'select', name: 'primarySiteId', label: 'Site principal', placeholder: 'Aucun', defaultValue: practitioner?.primarySiteId ?? '', options: sites.map((s) => ({ value: s.id, label: s.name })) },
    { kind: 'text', name: 'licenseNumber', label: 'Numéro d\'ordre', defaultValue: practitioner?.licenseNumber ?? '' },
    { kind: 'number', name: 'defaultConsultMinutes', label: 'Durée de consultation par défaut (minutes)', inputMode: 'numeric', defaultValue: String(practitioner?.defaultConsultMinutes ?? 20), hint: 'Entre 5 et 240 minutes.' },
    { kind: 'checkbox', name: 'isBookable', label: 'Réservable en ligne et à l\'accueil', defaultChecked: practitioner?.isBookable ?? true },
  ];
  if (!practitioner && users && users.length > 0) {
    fields.push({ kind: 'select', name: 'userId', label: 'Utilisateur lié (facultatif)', placeholder: 'Aucun', options: users.map((u) => ({ value: u.id, label: u.name })) });
  }
  return fields;
}

export function PractitionerForm(props: PractitionerFormProps) {
  const { practitioner } = props;
  return (
    <ActionForm
      action={practitioner ? updatePractitionerAction : createPractitionerAction}
      idPrefix="practitioner-"
      hidden={practitioner ? { id: practitioner.id } : {}}
      fields={fieldsFor(props)}
      submitLabel={practitioner ? 'Enregistrer' : 'Créer le praticien'}
      pendingLabel="Enregistrement…"
    />
  );
}
