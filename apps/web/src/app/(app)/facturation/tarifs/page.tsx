import type { Metadata } from 'next';
import Link from 'next/link';
import { createPriceItemAction, createPriceListAction, setDefaultPriceListAction } from '@/actions/billing-pricing';
import { ActionForm } from '@/components/forms/ActionForm';
import { PriceItemsTable } from '@/components/billing/PriceItemsTable';
import { AccessDenied } from '@/components/ui/AccessDenied';
import { Alert } from '@/components/ui/Alert';
import { Badge } from '@/components/ui/Badge';
import { PageHeader } from '@/components/ui/PageHeader';
import { settle } from '@/lib/api/settle';
import { canUse } from '@/lib/auth/me';
import { toPriceList, toPriceListItem, CATEGORY_LABELS } from '@/lib/domain/billing';
import { isZeroDecimalCurrency } from '@/lib/domain/money';
import { isUuid, items } from '@/lib/domain/raw';
import { pageApi } from '@/server/api';
import { requireMe } from '@/server/me';

export const metadata: Metadata = { title: 'Grille tarifaire' };

const ITEMS_LIMIT = 100;
const CATEGORY_OPTIONS = Object.entries(CATEGORY_LABELS).map(([value, label]) => ({ value, label }));

export default async function PricingPage({ searchParams }: { readonly searchParams: Promise<{ liste?: string }> }) {
  const me = await requireMe();
  if (!canUse(me, 'billing', 'billing:price_list:read')) return <AccessDenied what="la grille tarifaire" />;
  const canUpdate = canUse(me, 'billing', 'billing:price_list:update');
  const { liste } = await searchParams;

  const listsResult = await settle(() => pageApi('/billing/price-lists'));
  if (!listsResult.ok) return <Alert tone="error">{listsResult.message}</Alert>;
  const lists = items(listsResult.value.data, toPriceList);
  const selected = lists.find((l) => isUuid(liste) && l.id === liste) ?? lists.find((l) => l.isDefault) ?? lists[0];

  const itemsResult = selected
    ? await settle(() => pageApi(`/billing/price-lists/${selected.id}/items`, { query: { limit: ITEMS_LIMIT, includeInactive: canUpdate } }))
    : null;
  const priceItems = itemsResult?.ok ? items(itemsResult.value.data, toPriceListItem) : [];

  return (
    <>
      <PageHeader title="Grille tarifaire" description="Prix des consultations, actes, examens et médicaments facturés aux patients." />
      <div className="space-y-8">
        {lists.length > 0 ? (
          <nav aria-label="Grilles tarifaires" className="flex flex-wrap gap-2">
            {lists.map((list) => (
              <Link
                key={list.id}
                href={`/facturation/tarifs?liste=${list.id}`}
                aria-current={list.id === selected?.id ? 'page' : undefined}
                className={`rounded-md border px-3 py-2 text-sm font-medium ${list.id === selected?.id ? 'border-blue-700 bg-blue-700 text-white' : 'border-slate-400 bg-white text-slate-900 hover:bg-slate-100'}`}
              >
                {list.name} {list.isDefault ? '(par défaut)' : ''}
              </Link>
            ))}
          </nav>
        ) : (
          <Alert tone="info">Aucune grille tarifaire n&apos;est définie.{canUpdate ? ' Créez-en une ci-dessous.' : ''}</Alert>
        )}

        {selected ? (
          <section aria-labelledby="articles">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <h2 id="articles" className="text-lg font-semibold">{selected.name}</h2>
              {selected.isDefault ? <Badge tone="info">Par défaut</Badge> : null}
              {!selected.isActive ? <Badge tone="neutral">Inactive</Badge> : null}
            </div>
            {itemsResult && !itemsResult.ok ? <Alert tone="error">{itemsResult.message}</Alert> : <PriceItemsTable items={priceItems} currency={selected.currency} canUpdate={canUpdate} />}
            {canUpdate && !selected.isDefault ? (
              <div className="mt-3">
                <ActionForm action={setDefaultPriceListAction} hidden={{ priceListId: selected.id }} fields={[]} submitLabel="Désigner comme grille par défaut" variant="secondary" idPrefix="default-" />
              </div>
            ) : null}
          </section>
        ) : null}

        {canUpdate ? (
          <div className="grid gap-6 md:grid-cols-2">
            {selected ? (
              <section aria-labelledby="nouvel-article" className="rounded-md border border-slate-300 bg-white p-4">
                <h2 id="nouvel-article" className="mb-3 text-lg font-semibold">Ajouter un article</h2>
                <ActionForm
                  action={createPriceItemAction}
                  idPrefix="item-"
                  hidden={{ priceListId: selected.id, currency: selected.currency }}
                  fields={[
                    { kind: 'text', name: 'code', label: 'Code', required: true, hint: 'Lettres, chiffres, point ou tiret (ex. CONS-01).' },
                    { kind: 'text', name: 'label', label: 'Libellé', required: true },
                    { kind: 'select', name: 'category', label: 'Catégorie', options: CATEGORY_OPTIONS, required: true },
                    { kind: 'text', name: 'unitPrice', label: `Prix unitaire (${selected.currency})`, required: true, inputMode: isZeroDecimalCurrency(selected.currency) ? 'numeric' : 'decimal', hint: isZeroDecimalCurrency(selected.currency) ? 'Montant entier, sans décimales. Ex. 5 000' : 'Ex. 5 000' },
                    { kind: 'checkbox', name: 'isSensitive', label: 'Acte sensible', hint: 'Son libellé est masqué pour le personnel sans accès clinique et sur le reçu.' },
                    { kind: 'text', name: 'printLabel', label: 'Libellé imprimé', hint: 'Libellé neutre affiché à la place du libellé réel. Ne saisissez aucune information médicale.' },
                  ]}
                  submitLabel="Ajouter l'article"
                  pendingLabel="Ajout…"
                />
              </section>
            ) : null}
            <section aria-labelledby="nouvelle-grille" className="rounded-md border border-slate-300 bg-white p-4">
              <h2 id="nouvelle-grille" className="mb-3 text-lg font-semibold">Créer une grille</h2>
              <ActionForm
                action={createPriceListAction}
                idPrefix="list-"
                fields={[
                  { kind: 'text', name: 'code', label: 'Code', required: true },
                  { kind: 'text', name: 'name', label: 'Nom', required: true },
                  { kind: 'checkbox', name: 'isDefault', label: 'Grille par défaut', hint: 'Remplace la grille par défaut actuelle.' },
                ]}
                submitLabel="Créer la grille"
                pendingLabel="Création…"
              />
            </section>
          </div>
        ) : null}
      </div>
    </>
  );
}
