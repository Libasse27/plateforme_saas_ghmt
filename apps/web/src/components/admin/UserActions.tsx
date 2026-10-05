import { disableUserAction, enableUserAction, resendInvitationAction, revokeSessionsAction, unlockUserAction } from '@/actions/admin-users';
import { ActionForm } from '@/components/forms/ActionForm';
import { availableUserActions, type UserActionKind, type UserActionRights } from '@/lib/domain/admin';
import { ConfirmAction } from './ConfirmAction';

export interface UserActionsProps {
  readonly userId: string;
  readonly status: string;
  readonly rights: UserActionRights;
}

const DIRECT = {
  resend: { action: resendInvitationAction, label: 'Renvoyer l\'invitation' },
  enable: { action: enableUserAction, label: 'Réactiver le compte' },
  unlock: { action: unlockUserAction, label: 'Déverrouiller le compte' },
} as const;

const CONFIRMED = {
  disable: { action: disableUserAction, summary: 'Désactiver le compte', confirm: 'Confirmer la désactivation', warning: 'L\'utilisateur ne pourra plus se connecter et ses sessions seront coupées.' },
  revokeSessions: { action: revokeSessionsAction, summary: 'Révoquer les sessions', confirm: 'Confirmer la révocation', warning: 'L\'utilisateur sera déconnecté de tous ses appareils.' },
} as const;

function ActionView({ kind, userId }: { readonly kind: UserActionKind; readonly userId: string }) {
  if (kind === 'disable' || kind === 'revokeSessions') {
    const spec = CONFIRMED[kind];
    return <ConfirmAction action={spec.action} hidden={{ userId }} summary={spec.summary} confirmLabel={spec.confirm} warning={spec.warning} idPrefix={`${kind}-`} />;
  }
  const spec = DIRECT[kind];
  return <ActionForm action={spec.action} fields={[]} hidden={{ userId }} submitLabel={spec.label} pendingLabel="…" variant="secondary" idPrefix={`${kind}-`} />;
}

/** Boutons de la fiche utilisateur : selon le statut et les permissions (l'API reste l'arbitre). */
export function UserActions({ userId, status, rights }: UserActionsProps) {
  const kinds = availableUserActions(status, rights);
  if (kinds.length === 0) return null;
  return (
    <div className="flex flex-wrap items-start gap-3" role="group" aria-label="Actions sur le compte">
      {kinds.map((kind) => (
        <ActionView key={kind} kind={kind} userId={userId} />
      ))}
    </div>
  );
}
