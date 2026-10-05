import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { deleteSiteAction, updateSiteAction } from '@/actions/admin-org';
import { ConfirmAction } from '@/components/admin/ConfirmAction';
import { ActionForm } from '@/components/forms/ActionForm';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Alert } from '@/components/ui/Alert';
import { PageHeader } from '@/components/ui/PageHeader';
import { hasPermission } from '@/lib/auth/me';
import { toSiteAdmin } from '@/lib/domain/admin';
import { isUuid } from '@/lib/domain/raw';
import { requireMe } from '@/server/me';
import { loadOne } from '../../../_lib/page-data';

export const metadata: Metadata = { title: 'Site' };

export default async function SitePage({ params }: { readonly params: Promise<{ id: string }> }) {
  const me = await requireMe();
  if (!hasPermission(me, 'org:site:read')) return <AccessDenied what="les sites" />;
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const loaded = await loadOne(`/org/sites/${id}`, toSiteAdmin);
  if (!loaded.ok) return <Alert tone="error">{loaded.message}</Alert>;
  const site = loaded.value;

  return (
    <>
      <PageHeader title={site.name} description={`Site ${site.code}${site.isMain ? ' (principal)' : ''}`} />
      <div className="max-w-xl space-y-6">
        {hasPermission(me, 'org:site:update') ? (
          <ActionForm
            action={updateSiteAction}
            idPrefix="site-"
            hidden={{ id }}
            fields={[
              { kind: 'text', name: 'code', label: 'Code', required: true, defaultValue: site.code },
              { kind: 'text', name: 'name', label: 'Nom', required: true, defaultValue: site.name },
              { kind: 'text', name: 'city', label: 'Ville', defaultValue: site.city },
              { kind: 'text', name: 'countryCode', label: 'Pays (code à 2 lettres)', defaultValue: site.countryCode },
              { kind: 'text', name: 'timezone', label: 'Fuseau horaire', defaultValue: site.timezone },
            ]}
            submitLabel="Enregistrer"
            pendingLabel="Enregistrement…"
          />
        ) : null}
        {hasPermission(me, 'org:site:delete') && !site.isMain ? (
          <ConfirmAction action={deleteSiteAction} hidden={{ id }} summary="Supprimer le site" confirmLabel="Confirmer la suppression" warning="Le site doit être vide de services. Cette action est auditée." idPrefix="delete-site-" />
        ) : null}
        <p><Link href="/administration/organisation" className="text-blue-800 underline">Retour à l&apos;organisation</Link></p>
      </div>
    </>
  );
}
