'use client';

import { useActionState, useState } from 'react';
import { updateSecurityPolicyAction } from '@/actions/admin-security';
import { Alert } from '@/components/ui/Alert';
import { TextField } from '@/components/ui/Field';
import { FormMessage } from '@/components/ui/FormMessage';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { CLINICAL_MFA_LABELS, CLINICAL_MFA_MODES, type SecurityPolicyView } from '@/lib/domain/security';
import { EMPTY_FORM_STATE } from '@/lib/forms';
import { clinicalWithoutMfaSentence } from './TrustedNetworksPanel';
import { TOTP_CODE_FIELD } from './GuardedAction';

const ALWAYS_MFA_NOTE = 'Les rôles d\'administration, de direction, de comptabilité, de ressources humaines et de pharmacie restent soumis au second facteur partout.';

export interface SecurityPolicyFormProps {
  readonly policy: Pick<SecurityPolicyView, 'clinicalMfa'>;
  readonly canUpdate: boolean;
  /** Soignants actifs sans second facteur : cités avant de passer au mode « toujours » (docs/11 §14.4). */
  readonly clinicalUsersWithoutMfa?: number;
}

export function SecurityPolicyForm({ policy, canUpdate, clinicalUsersWithoutMfa = 0 }: SecurityPolicyFormProps) {
  const [state, formAction] = useActionState(updateSecurityPolicyAction, EMPTY_FORM_STATE);
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);

  if (!canUpdate) {
    return (
      <section aria-labelledby="politique" className="space-y-2">
        <h2 id="politique" className="text-lg font-semibold">Politique du second facteur</h2>
        <p className="text-sm text-slate-800">Second facteur des soignants : <strong>{CLINICAL_MFA_LABELS[policy.clinicalMfa]}</strong>.</p>
        <p className="text-sm text-slate-700">{ALWAYS_MFA_NOTE}</p>
        <p className="text-sm text-slate-700">Lecture seule : seul l&apos;administrateur principal peut modifier cette politique.</p>
      </section>
    );
  }

  const current = state.values?.clinicalMfa ?? policy.clinicalMfa;
  const choice = selected ?? current;
  const exposed = clinicalWithoutMfaSentence(clinicalUsersWithoutMfa);
  // Passer à « toujours » bloque aussitôt les soignants sans second facteur : une confirmation explicite est exigée.
  const needsConfirmation = choice === 'always' && policy.clinicalMfa !== 'always' && exposed !== '';
  return (
    <section aria-labelledby="politique" className="space-y-3">
      <h2 id="politique" className="text-lg font-semibold">Politique du second facteur</h2>
      <form action={formAction} className="space-y-4" noValidate>
        <FormMessage state={state} />
        <fieldset className="space-y-2" aria-describedby="politique-aide">
          <legend className="mb-1 text-sm font-medium text-slate-900">Second facteur des soignants (rôles cliniques) exigé :</legend>
          {CLINICAL_MFA_MODES.map((mode) => (
            <div key={mode} className="flex items-start gap-2">
              <input id={`mode-${mode}`} type="radio" name="clinicalMfa" value={mode} defaultChecked={current === mode} onChange={() => { setSelected(mode); setConfirmed(false); }} className="mt-1 h-4 w-4" />
              <label htmlFor={`mode-${mode}`} className="text-sm text-slate-900">{CLINICAL_MFA_LABELS[mode]}</label>
            </div>
          ))}
        </fieldset>
        <p id="politique-aide" className="text-sm text-slate-700">{ALWAYS_MFA_NOTE}</p>
        {state.fieldErrors?.clinicalMfa ? <p className="text-sm font-medium text-red-700">{state.fieldErrors.clinicalMfa}</p> : null}
        {needsConfirmation ? (
          <div className="space-y-2">
            <Alert tone="warning">{`${exposed} : ils ne pourront plus accéder aux dossiers tant qu'ils ne l'auront pas activé, même depuis le réseau de l'établissement.`}</Alert>
            <div className="flex items-start gap-2">
              <input id="politique-confirmation" type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} className="mt-1 h-4 w-4" />
              <label htmlFor="politique-confirmation" className="text-sm text-slate-900">Je confirme ce changement.</label>
            </div>
          </div>
        ) : null}
        <TextField
          name={TOTP_CODE_FIELD.name}
          label={TOTP_CODE_FIELD.label}
          hint={TOTP_CODE_FIELD.kind === 'text' ? TOTP_CODE_FIELD.hint : undefined}
          required
          inputMode="numeric"
          autoComplete="one-time-code"
          error={state.fieldErrors?.totpCode}
        />
        <SubmitButton pendingLabel="Enregistrement…" disabled={needsConfirmation && !confirmed}>Enregistrer la politique</SubmitButton>
      </form>
    </section>
  );
}
