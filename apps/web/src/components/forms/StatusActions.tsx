'use client';

import { useActionState } from 'react';
import { changeAppointmentStatusAction } from '@/actions/appointments';
import type { StatusActionSpec } from '@/lib/domain/appointments';
import { EMPTY_FORM_STATE } from '@/lib/forms';
import { TextField } from '@/components/ui/Field';
import { SubmitButton } from '@/components/ui/SubmitButton';

export function StatusActions({ appointmentId, actions }: { readonly appointmentId: string; readonly actions: readonly StatusActionSpec[] }) {
  const [state, formAction] = useActionState(changeAppointmentStatusAction, EMPTY_FORM_STATE);
  if (actions.length === 0) return null;
  const direct = actions.filter((a) => a.action !== 'cancel');
  const cancel = actions.find((a) => a.action === 'cancel');
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start gap-2">
        {direct.map((a) => (
          <form key={a.action} action={formAction}>
            <input type="hidden" name="appointmentId" value={appointmentId} />
            <input type="hidden" name="status" value={a.status} />
            <SubmitButton variant="secondary" pendingLabel="…">{a.label}</SubmitButton>
          </form>
        ))}
        {cancel ? (
          <details className="rounded-md border border-slate-400 bg-white">
            <summary className="cursor-pointer px-4 py-2 text-sm font-semibold text-red-800">{cancel.label}</summary>
            <form action={formAction} className="space-y-2 border-t border-slate-300 p-3">
              <input type="hidden" name="appointmentId" value={appointmentId} />
              <input type="hidden" name="status" value={cancel.status} />
              <TextField id={`cancel-reason-${appointmentId}`} name="cancelReason" label="Motif d'annulation" required error={state.fieldErrors?.cancelReason} />
              <SubmitButton variant="danger" pendingLabel="Annulation…">Confirmer l&apos;annulation</SubmitButton>
            </form>
          </details>
        ) : null}
      </div>
      {state.message ? (
        <p role={state.ok ? 'status' : 'alert'} className={`text-sm font-medium ${state.ok ? 'text-green-800' : 'text-red-700'}`}>
          {state.message}
        </p>
      ) : null}
    </div>
  );
}
