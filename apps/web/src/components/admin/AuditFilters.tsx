import Link from 'next/link';
import { Field } from './audit-field';
import { buttonClass, inputClass } from '@/components/ui/styles';
import { OUTCOME_LABELS, AUDIT_OUTCOMES, type AuditFilters as Filters } from '@/lib/domain/audit';

export interface AuditFiltersProps {
  readonly filters: Filters;
  readonly canExport: boolean;
}

const EXPORT_PATH = '/administration/journal/export';
const JOURNAL_PATH = '/administration/journal';

/** Filtres en query string : dates, codes d'action, identifiants opaques. Aucune recherche de patient. */
export function AuditFilters({ filters, canExport }: AuditFiltersProps) {
  const hidden: readonly (readonly [string, string | undefined])[] = [
    ['du', filters.from], ['au', filters.to], ['acteur', filters.actor], ['action', filters.action],
    ['ressource', filters.resourceType], ['idRessource', filters.resourceId], ['resultat', filters.outcome],
  ];
  return (
    <div className="mb-6 space-y-3">
      <form method="get" action={JOURNAL_PATH} className="grid gap-3 rounded-md border border-slate-300 bg-white p-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field id="du" label="Du"><input id="du" name="du" type="date" defaultValue={filters.from ?? ''} className={inputClass} /></Field>
        <Field id="au" label="Au"><input id="au" name="au" type="date" defaultValue={filters.to ?? ''} className={inputClass} /></Field>
        <Field id="resultat" label="Résultat">
          <select id="resultat" name="resultat" defaultValue={filters.outcome ?? ''} className={inputClass}>
            <option value="">Tous</option>
            {AUDIT_OUTCOMES.map((outcome) => <option key={outcome} value={outcome}>{OUTCOME_LABELS[outcome]}</option>)}
          </select>
        </Field>
        <Field id="action" label="Action" hint="Code exact ou préfixe, par exemple auth.*"><input id="action" name="action" defaultValue={filters.action ?? ''} className={inputClass} maxLength={100} /></Field>
        <Field id="ressource" label="Type de ressource"><input id="ressource" name="ressource" defaultValue={filters.resourceType ?? ''} className={inputClass} maxLength={50} /></Field>
        <Field id="idRessource" label="Identifiant de la ressource"><input id="idRessource" name="idRessource" defaultValue={filters.resourceId ?? ''} className={inputClass} /></Field>
        <Field id="acteur" label="Identifiant de l'acteur"><input id="acteur" name="acteur" defaultValue={filters.actor ?? ''} className={inputClass} /></Field>
        <div className="flex items-end gap-2">
          <button type="submit" className={buttonClass.primary}>Filtrer</button>
          <Link href={JOURNAL_PATH} className={buttonClass.secondary}>Réinitialiser</Link>
        </div>
      </form>
      {canExport ? (
        <form method="post" action={EXPORT_PATH}>
          {hidden.map(([name, value]) => (value ? <input key={name} type="hidden" name={name} value={value} /> : null))}
          <button type="submit" className={buttonClass.secondary}>Exporter en CSV</button>
        </form>
      ) : null}
    </div>
  );
}
