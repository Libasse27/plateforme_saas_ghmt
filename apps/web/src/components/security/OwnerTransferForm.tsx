import { transferOwnershipAction } from '@/actions/admin-security';
import { ActionForm } from '@/components/forms/ActionForm';
import { TOTP_CODE_FIELD } from './GuardedAction';

export interface TransferCandidate {
  readonly id: string;
  readonly fullName: string;
  readonly email: string;
}

/** Transfert du titre d'administrateur principal (docs/11 D9) : réservé au principal, confirmation explicite. */
export function OwnerTransferForm({ candidates }: { readonly candidates: readonly TransferCandidate[] }) {
  if (candidates.length === 0) {
    return <p className="text-sm text-slate-700">Aucun autre utilisateur actif ne peut recevoir le titre pour le moment.</p>;
  }
  return (
    <details className="max-w-xl rounded-md border border-slate-400 bg-white">
      <summary className="cursor-pointer px-4 py-2 text-sm font-semibold text-red-800">Transférer le titre</summary>
      <div className="space-y-3 border-t border-slate-300 p-3">
        <p className="text-sm text-slate-800">
          Vous perdrez le titre d&apos;administrateur principal : le nouveau titulaire pourra agir sur vous. Il doit être un administrateur actif, avec le second facteur activé.
        </p>
        <ActionForm
          action={transferOwnershipAction}
          idPrefix="owner-"
          fields={[
            {
              kind: 'select',
              name: 'userId',
              label: 'Nouvel administrateur principal',
              required: true,
              placeholder: 'Choisir un utilisateur',
              options: candidates.map((candidate) => ({ value: candidate.id, label: `${candidate.fullName} (${candidate.email})` })),
            },
            TOTP_CODE_FIELD,
          ]}
          submitLabel="Confirmer le transfert"
          pendingLabel="Transfert…"
          variant="danger"
        />
      </div>
    </details>
  );
}
