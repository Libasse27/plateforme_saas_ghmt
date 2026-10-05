import { updatePriceItemAction } from '@/actions/billing-pricing';
import { ActionForm } from '@/components/forms/ActionForm';
import { Badge } from '@/components/ui/Badge';
import { Cell, DataTable } from '@/components/ui/DataTable';
import { CATEGORY_LABELS, displayLabel, type PriceItem } from '@/lib/domain/billing';
import { formatMoney, isZeroDecimalCurrency } from '@/lib/domain/money';

export interface PriceItemsTableProps {
  readonly items: readonly PriceItem[];
  readonly currency: string;
  readonly canUpdate: boolean;
}

export function PriceItemsTable({ items, currency, canUpdate }: PriceItemsTableProps) {
  if (items.length === 0) return <p className="text-slate-700">Aucun article dans cette grille.</p>;
  const zeroDecimal = isZeroDecimalCurrency(currency);
  const columns = [{ header: 'Code' }, { header: 'Libellé' }, { header: 'Catégorie' }, { header: 'Prix unitaire', align: 'right' as const }, { header: 'Statut' }];
  return (
    <DataTable caption="Articles de la grille tarifaire" columns={canUpdate ? [...columns, { header: 'Modifier' }] : columns}>
      {items.map((item) => (
        <tr key={item.id}>
          <Cell className="font-mono">{item.code}</Cell>
          <Cell>{item.labelMasked ? displayLabel({ description: item.label, category: item.category, labelMasked: true, printLabel: item.printLabel }) : item.label}{item.isSensitive ? <Badge tone="warning">Sensible</Badge> : null}</Cell>
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
                    hidden={{ itemId: item.id, currency }}
                    fields={[{ kind: 'text', name: 'unitPrice', label: `Nouveau prix (${currency})`, required: true, defaultValue: item.unitPrice.replace(/\.00$/, ''), inputMode: zeroDecimal ? 'numeric' : 'decimal', ...(zeroDecimal ? { hint: 'Montant entier, sans décimales.' } : {}) }]}
                    submitLabel="Enregistrer le prix"
                    pendingLabel="Enregistrement…"
                  />
                  <ActionForm
                    action={updatePriceItemAction}
                    idPrefix={`sensitive-${item.id}-`}
                    hidden={{ itemId: item.id, currency, sensitivityForm: 'true' }}
                    fields={[
                      { kind: 'checkbox', name: 'isSensitive', label: 'Acte sensible', defaultChecked: item.isSensitive, hint: 'Son libellé est masqué pour le personnel sans accès clinique et sur le reçu.' },
                      { kind: 'text', name: 'printLabel', label: 'Libellé imprimé', defaultValue: item.printLabel ?? '', hint: 'Libellé neutre affiché à la place du libellé réel. Ne saisissez aucune information médicale.' },
                    ]}
                    submitLabel="Enregistrer la sensibilité"
                    pendingLabel="Enregistrement…"
                    variant="secondary"
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
