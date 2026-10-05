import Link from 'next/link';
import { createSiteAction } from '@/actions/admin-org';
import { ActionForm } from '@/components/forms/ActionForm';
import { Badge } from '@/components/ui/Badge';
import type { SiteAdminView } from '@/lib/domain/admin';

export interface SitesPanelProps {
  readonly sites: readonly SiteAdminView[];
  readonly canCreate: boolean;
  readonly canEdit: boolean;
  readonly defaultTimezone: string;
  readonly defaultCountry: string;
}

export function SitesPanel({ sites, canCreate, canEdit, defaultTimezone, defaultCountry }: SitesPanelProps) {
  return (
    <section aria-labelledby="sites" className="space-y-4">
      <h2 id="sites" className="text-lg font-semibold">Sites</h2>
      {sites.length === 0 ? (
        <p className="text-slate-700">Aucun site.</p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-md border border-slate-300 bg-white">
          {sites.map((site) => (
            <li key={site.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <span>
                <span className="font-medium">{site.name}</span> <span className="text-slate-700">({site.code}{site.city ? `, ${site.city}` : ''})</span>{' '}
                {site.isMain ? <Badge tone="info">Principal</Badge> : null}
              </span>
              {canEdit ? <Link href={`/administration/organisation/sites/${site.id}`} className="text-blue-800 underline">Modifier<span className="sr-only"> le site {site.name}</span></Link> : null}
            </li>
          ))}
        </ul>
      )}
      {canCreate ? (
        <div className="rounded-md border border-slate-300 bg-white p-4">
          <h3 className="mb-3 font-semibold">Créer un site</h3>
          <ActionForm
            action={createSiteAction}
            idPrefix="site-"
            fields={[
              { kind: 'text', name: 'code', label: 'Code', required: true },
              { kind: 'text', name: 'name', label: 'Nom', required: true },
              { kind: 'text', name: 'city', label: 'Ville' },
              { kind: 'text', name: 'countryCode', label: 'Pays (code à 2 lettres)', defaultValue: defaultCountry },
              { kind: 'text', name: 'timezone', label: 'Fuseau horaire', defaultValue: defaultTimezone },
            ]}
            submitLabel="Créer le site"
            pendingLabel="Création…"
          />
        </div>
      ) : null}
    </section>
  );
}
