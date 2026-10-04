import type { PriceListItemView } from '@ghmt/shared';
import { updatePriceItemAction } from '@/actions/billing-pricing';
import { ActionForm } from '@/components/forms/ActionForm';
import { Badge } from '@/components/ui/Badge';
import { Cell, DataTable } from '@/components/ui/DataTable';
import { CATEGORY_LABELS } from '@/lib/domain/billing';
import { formatMoney } from '@/lib/domain/money';

export interface PriceItemsTableProps {
  readonly items: readonly PriceListItemView[];
  readonly currency: string;
  readonly canUpdate: boolean;
}

export function PriceItemsTable({ items, currency, canUpdate }: PriceItemsTableProps) {
  if (items.length === 0) return <p className="text-slate-700">Aucun article dans cette grille.</p>;
  const columns = [{ header: 'Code' }, { header: 'Libellé' }, { header: 'Catégorie' }, { header: 'Prix unitaire', align: 'right' as const }, { header: 'Statut' }];
  return (
    <DataTable caption="Articles de la grille tarifaire" columns={canUpdate ? [...columns, { header: 'Modifier' }] : columns}>
      {items.map((item) => (
        <tr key={item.id}>
          <Cell className="font-mono">{item.code}</Cell>
          <Cell>{item.label}</Cell>
          <Cell>{CATEGORY_LABELS[item.category]}</Cell>
          <Cell align="right">{formatMoney(item.unitPrice, currency)}</Cell>
          <Cell><Badge tone={item.isActive ? 'success' : 'neutral'}>{item.isActive ? 'Actif' : 'Inactif'}</Badge></Cell>
          {canUpdate ? (
            <Cell>
              <details>
                <summary className="cursor-pointer font-semibold text-blue-800">Modifier le prix</summary>
                <div className="mt-2 min-w-56 space-y-3">
                  <ActionForm
                    action={updatePriceItemAction}
                    idPrefix={`price-${item.id}-`}
                    hidden={{ itemId: item.id }}
                    fields={[{ kind: 'text', name: 'unitPrice', label: `Nouveau prix (${currency})`, required: true, defaultValue: item.unitPrice.replace(/\.00$/, ''), inputMode: 'decimal' }]}
                    submitLabel="Enregistrer le prix"
                    pendingLabel="Enregistrement…"
                  />
                  <ActionForm
                    action={updatePriceItemAction}
                    idPrefix={`active-${item.id}-`}
                    hidden={{ itemId: item.id, isActive: item.isActive ? 'false' : 'true' }}
                    fields={[]}
                    submitLabel={item.isActive ? 'Désactiver' : 'Réactiver'}
                    variant="secondary"
                  />
                </div>
              </details>
            </Cell>
          ) : null}
        </tr>
      ))}
    </DataTable>
  );
}
