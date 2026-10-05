'use client';

import { useActionState } from 'react';
import { verifyAuditChainAction } from '@/actions/admin-audit';
import { FormMessage } from '@/components/ui/FormMessage';
import { SubmitButton } from '@/components/ui/SubmitButton';
import { EMPTY_FORM_STATE } from '@/lib/forms';

/** Vérification d'intégrité de la chaîne d'audit à la demande (résultat annoncé aux lecteurs d'écran). */
export function IntegrityCheck() {
  const [state, formAction] = useActionState(verifyAuditChainAction, EMPTY_FORM_STATE);
  return (
    <form action={formAction} className="mb-6 space-y-2">
      <SubmitButton variant="secondary" pendingLabel="Vérification…">Vérifier l&apos;intégrité</SubmitButton>
      <FormMessage state={state} />
    </form>
  );
}
