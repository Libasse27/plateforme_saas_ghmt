import type { ReactNode } from 'react';

/** Étiquette et aide d'un champ de filtre natif (formulaire GET sans JavaScript). */
export function Field({ id, label, hint, children }: { readonly id: string; readonly label: string; readonly hint?: string; readonly children: ReactNode }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium text-slate-900">{label}</label>
      {children}
      {hint ? <p className="text-sm text-slate-700">{hint}</p> : null}
    </div>
  );
}
