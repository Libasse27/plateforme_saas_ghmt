'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { createPatientAction } from '@/actions/patients';
import { EMPTY_FORM_STATE } from '@/lib/forms';
import type { DuplicateCandidate } from '@/lib/domain/mappers';
import { Alert } from '@/components/ui/Alert';
import { SelectField, TextField, type SelectOption } from '@/components/ui/Field';
import { FormMessage } from '@/components/ui/FormMessage';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { buttonClass } from '@/components/ui/styles';

export interface PatientFormProps {
  readonly sexOptions: readonly SelectOption[];
  readonly bloodGroupOptions: readonly SelectOption[];
}

/** Les listes de choix viennent du serveur : le schéma partagé (Zod) n'est pas embarqué dans le navigateur. */
export function PatientForm({ sexOptions, bloodGroupOptions }: PatientFormProps) {
  const [state, formAction] = useActionState(createPatientAction, EMPTY_FORM_STATE);
  const errors = state.fieldErrors ?? {};
  const values = state.values ?? {};
  const candidates = (state.extra?.candidates ?? []) as readonly DuplicateCandidate[];
  const forceable = state.extra?.forceable === true || candidates.length > 0;
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormMessage state={state} />
      {candidates.length > 0 ? (
        <Alert tone="warning">
          <p className="font-semibold">Dossiers existants proches :</p>
          <ul className="mt-1 list-disc pl-5">
            {candidates.map((c) => (
              <li key={c.id}>
                <Link href={`/patients/${encodeURIComponent(c.id)}`} className="underline">{c.fullName || c.id}</Link>
                {c.recordNumber ? ` (${c.recordNumber})` : ''}
                {c.birthYear ? `, né(e) en ${String(c.birthYear)}` : ''}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField name="lastName" label="Nom" required autoComplete="off" defaultValue={values.lastName} error={errors.lastName} />
        <TextField name="firstName" label="Prénom" required autoComplete="off" defaultValue={values.firstName} error={errors.firstName} />
        <SelectField name="sex" label="Sexe" options={sexOptions} defaultValue={values.sex ?? 'unknown'} error={errors.sex} />
        <TextField name="birthDate" type="date" label="Date de naissance" defaultValue={values.birthDate} error={errors.birthDate} />
        <div className="flex items-center gap-2 sm:col-span-2">
          <input id="f-birthDateEstimated" type="checkbox" name="birthDateEstimated" defaultChecked={values.birthDateEstimated === 'on'} className="size-5" />
          <label htmlFor="f-birthDateEstimated" className="text-sm text-slate-900">Date de naissance estimée</label>
        </div>
        <TextField
          name="phone"
          type="tel"
          label="Téléphone"
          hint="Format international, par exemple +221 77 123 45 67."
          autoComplete="off"
          inputMode="tel"
          defaultValue={values.phone}
          error={errors.phone}
        />
        <TextField name="email" type="email" label="Adresse e-mail" autoComplete="off" defaultValue={values.email} error={errors.email} />
        <SelectField name="bloodGroup" label="Groupe sanguin" options={bloodGroupOptions} placeholder="Non renseigné" defaultValue={values.bloodGroup} error={errors.bloodGroup} />
        <TextField name="nationalId" label="Pièce d'identité" defaultValue={values.nationalId} error={errors.nationalId} />
        <TextField name="address" label="Adresse" defaultValue={values.address} error={errors.address} />
        <TextField name="city" label="Ville" defaultValue={values.city} error={errors.city} />
      </div>
      {forceable ? (
        <fieldset className="space-y-2 rounded-md border border-amber-700 p-3">
          <legend className="px-1 text-sm font-semibold">Créer quand même</legend>
          <input type="hidden" name="candidatesJson" value={JSON.stringify(candidates)} />
          <TextField
            name="forceReason"
            label="Motif de création malgré le doublon suspecté"
            hint="Sans donnée de santé ni identité de patient. Ce motif est consigné dans le journal d'audit."
            minLength={3}
            maxLength={500}
            defaultValue={values.forceReason}
            error={errors.forceReason}
          />
          <button type="submit" name="force" value="1" className={buttonClass.danger}>Créer quand même</button>
        </fieldset>
      ) : null}
      <SubmitButton pendingLabel="Enregistrement…">Enregistrer le patient</SubmitButton>
    </form>
  );
}
