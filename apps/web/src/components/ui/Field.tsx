import type { InputHTMLAttributes, ReactNode } from 'react';
import { inputClass } from './styles';

interface FieldShellProps {
  readonly id: string;
  readonly label: string;
  readonly hint?: string | undefined;
  readonly error?: string | undefined;
  readonly required?: boolean | undefined;
  readonly children: (describedBy: string | undefined) => ReactNode;
}

function FieldShell({ id, label, hint, error, required, children }: FieldShellProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-slate-900">
        {label}
        {required ? <span aria-hidden="true" className="text-red-700"> *</span> : null}
      </label>
      {children(describedBy)}
      {hint ? <p id={hintId} className="text-sm text-slate-700">{hint}</p> : null}
      {error ? <p id={errorId} className="text-sm font-medium text-red-700">{error}</p> : null}
    </div>
  );
}

type InputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'id' | 'name'>;

export interface TextFieldProps extends InputProps {
  readonly name: string;
  readonly label: string;
  readonly hint?: string;
  readonly error?: string | undefined;
  /** Identifiant explicite quand le même champ apparaît plusieurs fois sur la page. */
  readonly id?: string;
}

export function TextField({ name, label, hint, error, required, id: idProp, ...rest }: TextFieldProps) {
  const id = idProp ?? `f-${name.replace(/\./g, '-')}`;
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={required}>
      {(describedBy) => (
        <input
          id={id}
          name={name}
          required={required}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={inputClass}
          {...rest}
        />
      )}
    </FieldShell>
  );
}

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SelectFieldProps {
  readonly name: string;
  readonly label: string;
  readonly options: readonly SelectOption[];
  readonly defaultValue?: string | undefined;
  readonly placeholder?: string;
  readonly hint?: string;
  readonly error?: string | undefined;
  readonly required?: boolean;
}

export function SelectField({ name, label, options, defaultValue, placeholder, hint, error, required }: SelectFieldProps) {
  const id = `f-${name.replace(/\./g, '-')}`;
  return (
    <FieldShell id={id} label={label} hint={hint} error={error} required={required}>
      {(describedBy) => (
        <select
          id={id}
          name={name}
          required={required}
          defaultValue={defaultValue ?? ''}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={inputClass}
        >
          {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
          {options.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      )}
    </FieldShell>
  );
}
