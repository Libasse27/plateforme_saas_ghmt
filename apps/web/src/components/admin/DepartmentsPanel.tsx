import Link from 'next/link';
import { createDepartmentAction } from '@/actions/admin-org';
import { ActionForm } from '@/components/forms/ActionForm';
import { DEPARTMENT_KIND_LABELS, type DepartmentView, type SiteAdminView } from '@/lib/domain/admin';

export interface DepartmentsPanelProps {
  readonly sites: readonly SiteAdminView[];
  readonly departments: readonly DepartmentView[];
  readonly canCreate: boolean;
  readonly canEdit: boolean;
}

export function DepartmentsPanel({ sites, departments, canCreate, canEdit }: DepartmentsPanelProps) {
  return (
    <section aria-labelledby="services" className="space-y-4">
      <h2 id="services" className="text-lg font-semibold">Services</h2>
      {departments.length === 0 ? (
        <p className="text-slate-700">Aucun service.</p>
      ) : (
        sites.map((site) => {
          const own = departments.filter((d) => d.siteId === site.id);
          return own.length === 0 ? null : (
            <div key={site.id}>
              <h3 className="mb-1 font-medium text-slate-900">{site.name}</h3>
              <ul className="divide-y divide-slate-200 rounded-md border border-slate-300 bg-white">
                {own.map((department) => (
                  <li key={department.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                    <span>
                      <span className="font-medium">{department.name}</span>{' '}
                      <span className="text-slate-700">({department.code}, {DEPARTMENT_KIND_LABELS[department.kind] ?? department.kind})</span>
                    </span>
                    {canEdit ? <Link href={`/administration/organisation/services/${department.id}`} className="text-blue-800 underline">Modifier<span className="sr-only"> le service {department.name}</span></Link> : null}
                  </li>
                ))}
              </ul>
            </div>
          );
        })
      )}
      {canCreate && sites.length > 0 ? (
        <div className="rounded-md border border-slate-300 bg-white p-4">
          <h3 className="mb-3 font-semibold">Créer un service</h3>
          <ActionForm
            action={createDepartmentAction}
            idPrefix="dept-"
            fields={[
              { kind: 'select', name: 'siteId', label: 'Site', required: true, placeholder: 'Choisir un site…', options: sites.map((s) => ({ value: s.id, label: s.name })) },
              { kind: 'text', name: 'code', label: 'Code', required: true },
              { kind: 'text', name: 'name', label: 'Nom', required: true },
              { kind: 'select', name: 'kind', label: 'Nature', defaultValue: 'clinical', options: Object.entries(DEPARTMENT_KIND_LABELS).map(([value, label]) => ({ value, label })) },
            ]}
            submitLabel="Créer le service"
            pendingLabel="Création…"
          />
        </div>
      ) : null}
    </section>
  );
}
