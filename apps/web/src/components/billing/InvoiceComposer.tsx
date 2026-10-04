'use client';

import { useActionState, useState } from 'react';
import { createInvoiceAction } from '@/actions/billing-invoices';
import { PatientSearch } from '@/components/forms/PatientSearch';
import { Alert } from '@/components/ui/Alert';
import { FormMessage } from '@/components/ui/FormMessage';
import { buttonClass, inputClass } from '@/components/ui/styles';
import { CATEGORY_LABELS } from '@/lib/domain/billing';
import {
  addCatalogLine,
  addFreeLine,
  draftTotal,
  removeLine,
  serializeLines,
  type CatalogItemRef,
  type DraftLine,
} from '@/lib/domain/billing-draft';
import { formatMoney } from '@/lib/domain/money';
import { EMPTY_FORM_STATE } from '@/lib/forms';

export interface InvoiceComposerProps {
  readonly sites: readonly { readonly value: string; readonly label: string }[];
  readonly catalog: readonly CatalogItemRef[];
  readonly currency: string;
  readonly allowFreeLines: boolean;
  readonly initialPatient?: { readonly id: string; readonly fullName: string } | undefined;
  readonly appointmentId?: string | undefined;
}

const CATEGORY_ENTRIES = Object.entries(CATEGORY_LABELS);

/**
 * Création d'une facture : patient choisi par la recherche POST existante (aucun terme dans l'URL),
 * lignes issues de la grille, ligne libre seulement avec `billing:invoice:update`. Le serveur recalcule les totaux.
 */
export function InvoiceComposer({ sites, catalog, currency, allowFreeLines, initialPatient, appointmentId }: InvoiceComposerProps) {
  const [state, formAction, pending] = useActionState(createInvoiceAction, EMPTY_FORM_STATE);
  const [patient, setPatient] = useState(initialPatient ?? null);
  const [lines, setLines] = useState<readonly DraftLine[]>([]);
  const [lineError, setLineError] = useState<string | null>(null);
  const errors = state.fieldErrors ?? {};

  function applyResult(result: ReturnType<typeof addCatalogLine>): boolean {
    if (!result.ok) {
      setLineError(result.error);
      return false;
    }
    setLineError(null);
    setLines(result.lines);
    return true;
  }

  function onAddCatalog(formData: FormData): void {
    const item = catalog.find((entry) => entry.id === formData.get('catalogItem'));
    if (!item) {
      setLineError('Choisissez un article de la grille.');
      return;
    }
    applyResult(addCatalogLine(lines, item, String(formData.get('catalogQuantity') ?? '1'), crypto.randomUUID()));
  }

  function onAddFree(formData: FormData): void {
    applyResult(
      addFreeLine(
        lines,
        {
          description: String(formData.get('freeDescription') ?? ''),
          category: String(formData.get('freeCategory') ?? ''),
          unitPrice: String(formData.get('freePrice') ?? ''),
          quantity: String(formData.get('freeQuantity') ?? '1'),
        },
        crypto.randomUUID(),
      ),
    );
  }

  return (
    <div className="space-y-6">
      <section aria-labelledby="etape-patient" className="rounded-md border border-slate-300 bg-white p-4">
        <h2 id="etape-patient" className="mb-3 text-lg font-semibold">1. Patient</h2>
        {patient ? (
          <p className="flex flex-wrap items-center gap-3">
            <span className="font-medium">{patient.fullName}</span>
            <button type="button" className={buttonClass.secondary} onClick={() => { setPatient(null); }}>Changer de patient</button>
          </p>
        ) : (
          <PatientSearch onSelect={(selected) => { setPatient({ id: selected.id, fullName: selected.fullName }); }} />
        )}
        {errors.patientId ? <p className="mt-2 text-sm font-medium text-red-700">{errors.patientId}</p> : null}
      </section>

      <section aria-labelledby="etape-lignes" className="rounded-md border border-slate-300 bg-white p-4">
        <h2 id="etape-lignes" className="mb-3 text-lg font-semibold">2. Lignes de la facture</h2>
        {catalog.length === 0 ? <Alert tone="warning">La grille tarifaire par défaut est vide ou indisponible.{allowFreeLines ? ' Vous pouvez saisir des lignes libres.' : ''}</Alert> : null}

        {catalog.length > 0 ? (
          <form action={onAddCatalog} className="mb-4 flex flex-wrap items-end gap-3">
            <div className="min-w-56 flex-1">
              <label htmlFor="catalogItem" className="mb-1 block text-sm font-medium">Article de la grille</label>
              <select id="catalogItem" name="catalogItem" className={inputClass} defaultValue="">
                <option value="" disabled>Choisir un article…</option>
                {catalog.map((item) => (
                  <option key={item.id} value={item.id}>{item.label} - {formatMoney(item.unitPrice, currency)}</option>
                ))}
              </select>
            </div>
            <div className="w-28">
              <label htmlFor="catalogQuantity" className="mb-1 block text-sm font-medium">Quantité</label>
              <input id="catalogQuantity" name="catalogQuantity" defaultValue="1" inputMode="decimal" className={inputClass} />
            </div>
            <button type="submit" className={buttonClass.secondary}>Ajouter la ligne</button>
          </form>
        ) : null}

        {allowFreeLines ? (
          <details className="mb-4 rounded-md border border-slate-300 p-3">
            <summary className="cursor-pointer font-semibold text-blue-800">Ajouter une ligne libre</summary>
            <form action={onAddFree} className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="freeDescription" className="mb-1 block text-sm font-medium">Libellé</label>
                <input id="freeDescription" name="freeDescription" className={inputClass} />
              </div>
              <div>
                <label htmlFor="freeCategory" className="mb-1 block text-sm font-medium">Catégorie</label>
                <select id="freeCategory" name="freeCategory" className={inputClass} defaultValue="autre">
                  {CATEGORY_ENTRIES.map(([value, label]) => (
                    <option key={value} value={value}>{label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="freePrice" className="mb-1 block text-sm font-medium">Prix unitaire ({currency})</label>
                <input id="freePrice" name="freePrice" inputMode="decimal" className={inputClass} />
              </div>
              <div>
                <label htmlFor="freeQuantity" className="mb-1 block text-sm font-medium">Quantité</label>
                <input id="freeQuantity" name="freeQuantity" defaultValue="1" inputMode="decimal" className={inputClass} />
              </div>
              <div className="sm:col-span-2"><button type="submit" className={buttonClass.secondary}>Ajouter la ligne libre</button></div>
            </form>
          </details>
        ) : null}

        {lineError ? <p role="alert" className="mb-3 text-sm font-medium text-red-700">{lineError}</p> : null}
        {errors.lines ? <p role="alert" className="mb-3 text-sm font-medium text-red-700">{errors.lines}</p> : null}

        {lines.length === 0 ? (
          <p className="text-slate-700">Aucune ligne pour le moment.</p>
        ) : (
          <ul className="divide-y divide-slate-200 rounded-md border border-slate-300" aria-label="Lignes ajoutées">
            {lines.map((line) => (
              <li key={line.key} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span>
                  {line.kind === 'catalog' ? line.label : line.description} <span className="text-slate-700">× {line.quantity} à {formatMoney(line.unitPrice, currency)}</span>
                </span>
                <button type="button" className={buttonClass.secondary} onClick={() => { setLines(removeLine(lines, line.key)); }} aria-label={`Retirer ${line.kind === 'catalog' ? line.label : line.description}`}>Retirer</button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-right text-lg font-semibold" aria-live="polite">Total estimé : {formatMoney(draftTotal(lines), currency)}</p>
      </section>

      <form action={formAction} className="space-y-4 rounded-md border border-slate-300 bg-white p-4" noValidate>
        <h2 className="text-lg font-semibold">3. Site et validation</h2>
        <FormMessage state={state} />
        <input type="hidden" name="patientId" value={patient?.id ?? ''} />
        <input type="hidden" name="lines" value={serializeLines(lines)} />
        {appointmentId ? <input type="hidden" name="appointmentId" value={appointmentId} /> : null}
        <div>
          <label htmlFor="siteId" className="mb-1 block text-sm font-medium">Site</label>
          <select id="siteId" name="siteId" required className={inputClass} defaultValue={sites.length === 1 ? sites[0]?.value : ''} aria-invalid={errors.siteId ? true : undefined}>
            <option value="" disabled>Choisir le site…</option>
            {sites.map((site) => (
              <option key={site.value} value={site.value}>{site.label}</option>
            ))}
          </select>
          {errors.siteId ? <p className="text-sm font-medium text-red-700">{errors.siteId}</p> : null}
        </div>
        <div>
          <label htmlFor="notes" className="mb-1 block text-sm font-medium">Note (facultative)</label>
          <input id="notes" name="notes" maxLength={500} className={inputClass} />
        </div>
        <div className="flex flex-wrap gap-3">
          <button type="submit" name="intent" value="draft" disabled={pending} className={buttonClass.secondary}>Enregistrer le brouillon</button>
          <button type="submit" name="intent" value="issue" disabled={pending} className={buttonClass.primary}>{pending ? 'Envoi…' : 'Créer et émettre'}</button>
        </div>
      </form>
    </div>
  );
}
