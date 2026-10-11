import { ActionForm, type ActionFormProps, type FieldSpec } from '@/components/forms/ActionForm';

/** Champ « code du second facteur » des opérations de pouvoir (docs/11 §14.1). */
export const TOTP_CODE_FIELD: FieldSpec = {
  kind: 'text',
  name: 'totpCode',
  label: 'Code du second facteur',
  hint: 'Code à 6 chiffres de votre application d\'authentification, exigé pour cette opération sensible.',
  required: true,
  autoComplete: 'one-time-code',
  inputMode: 'numeric',
};

/** Rappel affiché avant toute levée de contrôle d'accès (réinitialisation du second facteur, déverrouillage). */
export const IDENTITY_REMINDER = 'Vérifiez l\'identité de la personne en face à face ou par rappel sur un numéro connu.';

/** Champ « motif » obligatoire (10 à 500 caractères) repris dans le journal d'audit. */
export const REASON_FIELD: FieldSpec = {
  kind: 'textarea',
  name: 'reason',
  label: 'Motif (consigné dans le journal d\'audit)',
  hint: IDENTITY_REMINDER,
  required: true,
  rows: 3,
  maxLength: 500,
};

export interface GuardedActionProps extends Pick<ActionFormProps, 'action' | 'hidden' | 'idPrefix'> {
  /** Libellé du bouton qui déplie la confirmation. */
  readonly summary: string;
  readonly confirmLabel: string;
  readonly warning: string;
  /** Champs exigés avant l'envoi (code du second facteur, motif). */
  readonly fields: readonly FieldSpec[];
}

/** Action sensible en deux temps : avertissement, champs obligatoires (code, motif), puis envoi. */
export function GuardedAction({ action, hidden, summary, confirmLabel, warning, fields, idPrefix }: GuardedActionProps) {
  return (
    <details className="rounded-md border border-slate-400 bg-white">
      <summary className="cursor-pointer px-4 py-2 text-sm font-semibold text-red-800">{summary}</summary>
      <div className="space-y-3 border-t border-slate-300 p-3">
        <p className="text-sm text-slate-800">{warning}</p>
        <ActionForm action={action} fields={fields} hidden={hidden ?? {}} submitLabel={confirmLabel} pendingLabel="…" variant="danger" idPrefix={idPrefix ?? 'guard-'} />
      </div>
    </details>
  );
}
