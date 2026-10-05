import { simulateSandboxPaymentAction } from '@/actions/payments';
import { ActionForm } from '@/components/forms/ActionForm';
import { Alert } from '@/components/ui/Alert';

export function SandboxPayment({ reference, returnTo }: { readonly reference: string; readonly returnTo: string }) {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Paiement simulé (développement)</h1>
      <Alert tone="warning">Page de test du fournisseur « sandbox » : elle n&apos;existe pas en production. Aucun argent n&apos;est débité.</Alert>
      <p>Référence du paiement : <code className="rounded bg-slate-200 px-1 font-mono">{reference}</code></p>
      <div className="grid gap-4 sm:grid-cols-2">
        <ActionForm action={simulateSandboxPaymentAction} idPrefix="ok-" hidden={{ providerReference: reference, outcome: 'success', retour: returnTo }} fields={[]} submitLabel="Simuler un paiement réussi" pendingLabel="Simulation…" />
        <ActionForm action={simulateSandboxPaymentAction} idPrefix="ko-" hidden={{ providerReference: reference, outcome: 'failure', retour: returnTo }} fields={[]} submitLabel="Simuler un paiement échoué" variant="danger" pendingLabel="Simulation…" />
      </div>
    </div>
  );
}
