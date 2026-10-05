import { patternMatches, type PermissionKey } from '@ghmt/shared';
import { PERMISSION_ACTION_LABELS, type MatrixModule, type PermissionEntry } from '@/lib/domain/admin';

export interface RoleMatrixProps {
  readonly matrix: readonly MatrixModule[];
  /** Permissions actuelles du rôle. */
  readonly selected: readonly string[];
  /** Motifs de permission du lecteur : une case non détenue est désactivée (l'API reste l'arbitre). */
  readonly held: readonly string[];
  /** Rôle système : consultation seule. */
  readonly readOnly?: boolean;
}

function isHeld(held: readonly string[], code: string): boolean {
  return held.some((pattern) => patternMatches(pattern, code as PermissionKey));
}

function Cell({ module, resource, action, entry, checked, disabled }: {
  readonly module: string;
  readonly resource: string;
  readonly action: string;
  readonly entry: PermissionEntry | undefined;
  readonly checked: boolean;
  readonly disabled: boolean;
}) {
  if (!entry) return <td className="px-3 py-2 text-center text-slate-500" aria-label="Non applicable">-</td>;
  const label = `${module} ${resource} ${PERMISSION_ACTION_LABELS[action] ?? action}`;
  return (
    <td className="px-3 py-2 text-center">
      <input type="checkbox" name="permissions" value={entry.code} defaultChecked={checked} disabled={disabled} aria-label={label} className="h-4 w-4" />
      {entry.isSensitive ? <span className="ml-1 text-xs text-amber-900">sensible</span> : null}
    </td>
  );
}

/**
 * Matrice modules x ressources x actions issue du catalogue. Les cases cochées mais désactivées (non détenues)
 * sont reposées en champ caché pour qu'un enregistrement ne retire pas des permissions que le lecteur ne voit pas.
 */
export function RoleMatrix({ matrix, selected, held, readOnly = false }: RoleMatrixProps) {
  if (matrix.length === 0) return <p className="text-slate-700">Catalogue de permissions indisponible.</p>;
  const chosen = new Set(selected);
  const preserved = readOnly ? [] : selected.filter((code) => !isHeld(held, code));
  return (
    <div className="space-y-4">
      {preserved.map((code) => (
        <input key={code} type="hidden" name="permissions" value={code} />
      ))}
      {matrix.map((module) => (
        <fieldset key={module.module} className="overflow-x-auto rounded-md border border-slate-300 bg-white">
          <legend className="px-2 font-semibold">{module.name}</legend>
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-100">
              <tr>
                <th scope="col" className="px-3 py-2">Ressource</th>
                {module.actions.map((action) => (
                  <th key={action} scope="col" className="px-3 py-2 text-center">{PERMISSION_ACTION_LABELS[action] ?? action}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {module.resources.map((resource) => (
                <tr key={resource.resource} className="border-t border-slate-200">
                  <th scope="row" className="px-3 py-2 font-medium">{resource.resource}</th>
                  {module.actions.map((action) => {
                    const entry = resource.cells[action];
                    return (
                      <Cell
                        key={action}
                        module={module.name}
                        resource={resource.resource}
                        action={action}
                        entry={entry}
                        checked={entry ? chosen.has(entry.code) : false}
                        disabled={readOnly || !entry || !isHeld(held, entry.code)}
                      />
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </fieldset>
      ))}
    </div>
  );
}
