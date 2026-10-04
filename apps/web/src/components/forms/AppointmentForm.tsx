'use client';

import { useActionState } from 'react';
import { createAppointmentAction } from '@/actions/appointments';
import { EMPTY_FORM_STATE } from '@/lib/forms';
import { FormMessage } from '@/components/ui/FormMessage';
import { SelectField, TextField, type SelectOption } from '@/components/ui/Field';
import { SubmitButton } from '@/components/ui/SubmitButton';

const DEFAULT_DURATION = '20';

export interface AppointmentFormProps {
  readonly patientId: string;
  readonly patientName: string;
  readonly practitioners: readonly SelectOption[];
  readonly sites: readonly SelectOption[];
  readonly date: string;
}

export function AppointmentForm({ patientId, patientName, practitioners, sites, date }: AppointmentFormProps) {
  const [state, formAction] = useActionState(createAppointmentAction, EMPTY_FORM_STATE);
  const errors = state.fieldErrors ?? {};
  const values = state.ok ? {} : (state.values ?? {});
  return (
    <form action={formAction} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="patientId" value={patientId} />
      <p className="text-sm text-slate-900">
        Patient : <strong>{patientName}</strong>
      </p>
      {errors.patientId ? <p className="text-sm font-medium text-red-700">{errors.patientId}</p> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField name="practitionerId" label="Praticien" required options={practitioners} placeholder="Choisir…" defaultValue={values.practitionerId} error={errors.practitionerId} />
        <SelectField
          name="siteId"
          label="Site"
          required
          options={sites}
          placeholder={sites.length === 1 ? undefined : 'Choisir…'}
          defaultValue={values.siteId}
          error={errors.siteId}
        />
        <TextField name="date" type="date" label="Date" required defaultValue={values.date ?? date} error={errors.date} />
        <TextField name="time" type="time" label="Heure de début" required defaultValue={values.time} error={errors.time} />
        <TextField name="duration" type="number" min={5} max={240} step={5} label="Durée (minutes)" required defaultValue={values.duration ?? DEFAULT_DURATION} error={errors.duration} />
        <TextField name="reason" label="Motif" defaultValue={values.reason} error={errors.reason} />
      </div>
      <SubmitButton pendingLabel="Création…">Créer le rendez-vous</SubmitButton>
    </form>
  );
}
