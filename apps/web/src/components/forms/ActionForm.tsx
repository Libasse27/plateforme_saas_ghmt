'use client';

import { useActionState } from 'react';
import { TextField, SelectField, type SelectOption } from '@/components/ui/Field';
import { FormMessage } from '@/components/ui/FormMessage';
import { SubmitButton } from '@/components/ui/SubmitButton';
import type { buttonClass } from '@/components/ui/styles';
import { inputClass } from '@/components/ui/styles';
import { EMPTY_FORM_STATE, type FormState } from '@/lib/forms';

type TextKind = 'text' | 'number' | 'date' | 'tel' | 'email' | 'password';

interface BaseField {
  readonly name: string;
  readonly label: string;
  readonly hint?: string;
  readonly required?: boolean;
}

export type FieldSpec =
  | (BaseField & { readonly kind: TextKind; readonly defaultValue?: string; readonly autoComplete?: string; readonly inputMode?: 'numeric' | 'decimal' | 'tel' | 'text' })
  | (BaseField & { readonly kind: 'select'; readonly options: readonly SelectOption[]; readonly defaultValue?: string; readonly placeholder?: string })
  | (BaseField & { readonly kind: 'checkbox'; readonly defaultChecked?: boolean })
  | (BaseField & { readonly kind: 'textarea'; readonly defaultValue?: string; readonly rows?: number });

export interface ActionFormProps {
  /** Server Action de l'écriture. */
  readonly action: (prev: FormState, formData: FormData) => Promise<FormState>;
  readonly fields: readonly FieldSpec[];
  /** Valeurs fixes (identifiants) transmises avec le formulaire. */
  readonly hidden?: Readonly<Record<string, string>>;
  readonly submitLabel: string;
  readonly pendingLabel?: string;
  readonly variant?: keyof typeof buttonClass;
  readonly idPrefix?: string;
}

const HTTP_URL = /^https?:\/\//i;

function FieldView({ field, state, idPrefix }: { readonly field: FieldSpec; readonly state: FormState; readonly idPrefix: string }) {
  const error = state.fieldErrors?.[field.name];
  const value = state.values?.[field.name];
  const id = `${idPrefix}${field.name.replace(/\./g, '-')}`;
  if (field.kind === 'select') {
    return (
      <SelectField
        name={field.name}
        label={field.label}
        options={field.options}
        defaultValue={value ?? field.defaultValue}
        {...(field.placeholder !== undefined ? { placeholder: field.placeholder } : {})}
        {...(field.hint ? { hint: field.hint } : {})}
        error={error}
        {...(field.required ? { required: true } : {})}
      />
    );
  }
  if (field.kind === 'checkbox') {
    return (
      <div className="flex items-start gap-2">
        <input id={id} type="checkbox" name={field.name} defaultChecked={field.defaultChecked} className="mt-1 h-4 w-4" />
        <label htmlFor={id} className="text-sm font-medium text-slate-900">
          {field.label}
          {field.hint ? <span className="block font-normal text-slate-700">{field.hint}</span> : null}
        </label>
      </div>
    );
  }
  if (field.kind === 'textarea') {
    return (
      <div className="space-y-1">
        <label htmlFor={id} className="block text-sm font-medium text-slate-900">{field.label}</label>
        <textarea id={id} name={field.name} rows={field.rows ?? 3} defaultValue={value ?? field.defaultValue} required={field.required} aria-invalid={error ? true : undefined} className={inputClass} />
        {error ? <p className="text-sm font-medium text-red-700">{error}</p> : null}
      </div>
    );
  }
  return (
    <TextField
      id={id}
      name={field.name}
      type={field.kind}
      label={field.label}
      {...(field.hint ? { hint: field.hint } : {})}
      error={error}
      {...(field.required ? { required: true } : {})}
      defaultValue={value ?? field.defaultValue}
      {...(field.autoComplete ? { autoComplete: field.autoComplete } : {})}
      {...(field.inputMode ? { inputMode: field.inputMode } : {})}
    />
  );
}

/**
 * Formulaire générique branché sur une Server Action : champs décrits par des données sérialisables
 * (utilisable depuis un composant serveur), erreurs par champ, message global et, pour les paiements,
 * instructions et lien de reprise renvoyés par l'action.
 */
export function ActionForm({ action, fields, hidden = {}, submitLabel, pendingLabel, variant = 'primary', idPrefix = 'f-' }: ActionFormProps) {
  const [state, formAction] = useActionState(action, EMPTY_FORM_STATE);
  const instructions = typeof state.extra?.instructions === 'string' ? state.extra.instructions : null;
  const checkoutUrl = typeof state.extra?.checkoutUrl === 'string' && HTTP_URL.test(state.extra.checkoutUrl) ? state.extra.checkoutUrl : null;
  return (
    <form action={formAction} className="space-y-3" noValidate>
      <FormMessage state={state} />
      {instructions ? <p className="rounded-md border border-blue-700 bg-blue-50 px-3 py-2 text-sm text-blue-900">{instructions}</p> : null}
      {checkoutUrl ? (
        <p>
          <a href={checkoutUrl} className="font-semibold text-blue-800 underline" rel="noopener noreferrer">Continuer vers le paiement</a>
        </p>
      ) : null}
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {fields.map((field) => (
        <FieldView key={field.name} field={field} state={state} idPrefix={idPrefix} />
      ))}
      <SubmitButton variant={variant} {...(pendingLabel ? { pendingLabel } : {})}>{submitLabel}</SubmitButton>
    </form>
  );
}
