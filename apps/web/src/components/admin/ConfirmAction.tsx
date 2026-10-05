import { ActionForm } from '@/components/forms/ActionForm';
import type { FormState } from '@/lib/forms';

export interface ConfirmActionProps {
  readonly action: (prev: FormState, formData: FormData) => Promise<FormState>;
  readonly hidden: Readonly<Record<string, string>>;
  /** Libellé du bouton qui déplie la confirmation. */
  readonly summary: string;
  readonly confirmLabel: string;
  readonly warning: string;
  readonly idPrefix: string;
}

/** Action destructive en deux temps : la confirmation explicite est dépliée avant l'envoi (sans JavaScript requis). */
export function ConfirmAction({ action, hidden, summary, confirmLabel, warning, idPrefix }: ConfirmActionProps) {
  return (
    <details className="rounded-md border border-slate-400 bg-white">
      <summary className="cursor-pointer px-4 py-2 text-sm font-semibold text-red-800">{summary}</summary>
      <div className="space-y-2 border-t border-slate-300 p-3">
        <p className="text-sm text-slate-800">{warning}</p>
        <ActionForm action={action} fields={[]} hidden={hidden} submitLabel={confirmLabel} pendingLabel="…" variant="danger" idPrefix={idPrefix} />
      </div>
    </details>
  );
}
