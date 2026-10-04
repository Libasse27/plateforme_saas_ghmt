'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { searchPatientsAction } from '@/actions/patients';
import { Alert } from '@/components/ui/Alert';
import { FormMessage } from '@/components/ui/FormMessage';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { buttonClass, inputClass } from '@/components/ui/styles';
import { SEX_LABELS } from '@/lib/domain/labels';
import type { PatientView } from '@/lib/domain/mappers';
import { EMPTY_FORM_STATE } from '@/lib/forms';
import { formatBirthDate } from '@/lib/format/dates';

export interface PatientSearchProps {
  /** Mode « choix » (prise de rendez-vous) : un bouton remplace le lien vers la fiche. */
  readonly onSelect?: (patient: PatientView) => void;
}

/**
 * Recherche par Server Action (POST) : le terme saisi (nom, téléphone) n'apparaît jamais dans l'URL.
 * La pagination ne transmet que le curseur opaque renvoyé par l'API.
 */
export function PatientSearch({ onSelect }: PatientSearchProps) {
  const [state, formAction] = useActionState(searchPatientsAction, EMPTY_FORM_STATE);
  const patients = (state.extra?.patients ?? []) as readonly PatientView[];
  const nextCursor = typeof state.extra?.nextCursor === 'string' ? state.extra.nextCursor : null;
  const paged = state.extra?.paged === true;
  const searched = state.ok === true;
  const term = state.values?.q ?? '';

  return (
    <div className="space-y-4">
      <form action={formAction} role="search" className="flex flex-wrap items-end gap-3">
        <div className="min-w-64 flex-1">
          <label htmlFor="q" className="mb-1 block text-sm font-medium">Nom, téléphone ou n° de dossier</label>
          <input id="q" name="q" type="search" defaultValue={term} placeholder="Diallo, 77 123 45 67 ou P26-0004217" autoComplete="off" className={inputClass} />
        </div>
        <SubmitButton pendingLabel="Recherche…">Rechercher</SubmitButton>
      </form>

      <FormMessage state={state.ok ? {} : state} />
      {searched && patients.length === 0 ? <p className="text-slate-700">Aucun patient ne correspond à cette recherche.</p> : null}

      {patients.length > 0 ? (
        <div className="overflow-x-auto rounded-md border border-slate-300 bg-white">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Résultats de la recherche</caption>
            <thead className="bg-slate-100">
              <tr>
                <th scope="col" className="px-3 py-2">Patient</th>
                <th scope="col" className="px-3 py-2">N° dossier</th>
                <th scope="col" className="px-3 py-2">Naissance</th>
                <th scope="col" className="px-3 py-2">Sexe</th>
                <th scope="col" className="px-3 py-2">Ville</th>
                {onSelect ? <th scope="col" className="px-3 py-2"><span className="sr-only">Action</span></th> : null}
              </tr>
            </thead>
            <tbody>
              {patients.map((p) => (
                <tr key={p.id} className="border-t border-slate-200">
                  <td className="px-3 py-2">
                    {onSelect ? p.fullName : <Link href={`/patients/${encodeURIComponent(p.id)}`} className="font-semibold text-blue-800 underline">{p.fullName}</Link>}
                  </td>
                  <td className="px-3 py-2">{p.recordNumber || '-'}</td>
                  <td className="px-3 py-2">
                    {formatBirthDate(p.birthDate) || '-'}
                    {p.birthDate && p.birthDateEstimated ? <span className="ml-1 text-slate-700">(estimée)</span> : null}
                  </td>
                  <td className="px-3 py-2">{SEX_LABELS[p.sex] ?? '-'}</td>
                  <td className="px-3 py-2">{p.city || '-'}</td>
                  {onSelect ? (
                    <td className="px-3 py-2">
                      <button type="button" className={buttonClass.secondary} onClick={() => { onSelect(p); }} aria-label={`Choisir ${p.fullName}`}>Choisir</button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {paged || nextCursor ? (
        <nav aria-label="Pagination" className="flex gap-3">
          {paged ? (
            <form action={formAction}>
              <input type="hidden" name="q" value={term} />
              <button type="submit" className={buttonClass.secondary}>Retour au début</button>
            </form>
          ) : null}
          {nextCursor ? (
            <form action={formAction}>
              <input type="hidden" name="q" value={term} />
              <input type="hidden" name="cursor" value={nextCursor} />
              <button type="submit" className={buttonClass.secondary}>Page suivante</button>
            </form>
          ) : null}
        </nav>
      ) : null}
      {searched && nextCursor ? <Alert tone="info">D&apos;autres résultats existent : affinez la recherche ou passez à la page suivante.</Alert> : null}
    </div>
  );
}
