import { disableUserAction, enableUserAction, resendInvitationAction, resetUserMfaAction, revokeSessionsAction, unlockUserAction } from '@/actions/admin-users';
import { ActionForm } from '@/components/forms/ActionForm';
import { GuardedAction, REASON_FIELD } from '@/components/security/GuardedAction';
import { availableUserActions, type UserActionFlags, type UserActionKind, type UserActionRights } from '@/lib/domain/admin';
import { ConfirmAction } from './ConfirmAction';

export interface UserActionsProps {
  readonly userId: string;
  readonly status: string;
  readonly rights: UserActionRights;
  /** Second facteur actif et connexion ralentie (docs/11 §14.1) : masquent ou proposent des actions. */
  readonly flags?: UserActionFlags;
}

const DIRECT = {
  resend: { action: resendInvitationAction, label: 'Renvoyer l\'invitation' },
  enable: { action: enableUserAction, label: 'Réactiver le compte' },
} as const;

/** Levées de contrôle d'accès : motif obligatoire (journal d'audit) et rappel de vérifier l'identité (docs/11 §14.4.4). */
const WITH_REASON = {
  unlock: {
    action: unlockUserAction,
    summary: 'Déverrouiller le compte',
    confirm: 'Confirmer le déverrouillage',
    warning: 'Le délai de connexion dû aux échecs sera levé.',
  },
  resetMfa: {
    action: resetUserMfaAction,
    summary: 'Réinitialiser le second facteur',
    confirm: 'Confirmer la réinitialisation',
    warning: 'Le second facteur de l\'utilisateur sera supprimé, ses sessions seront coupées et il devra enrôler à nouveau son application d\'authentification. Il en sera informé par e-mail.',
  },
} as const;

const CONFIRMED = {
  disable: { action: disableUserAction, summary: 'Désactiver le compte', confirm: 'Confirmer la désactivation', warning: 'L\'utilisateur ne pourra plus se connecter et ses sessions seront coupées.' },
  revokeSessions: { action: revokeSessionsAction, summary: 'Révoquer les sessions', confirm: 'Confirmer la révocation', warning: 'L\'utilisateur sera déconnecté de tous ses appareils.' },
} as const;

function ActionView({ kind, userId }: { readonly kind: UserActionKind; readonly userId: string }) {
  if (kind === 'unlock' || kind === 'resetMfa') {
    const spec = WITH_REASON[kind];
    return <GuardedAction action={spec.action} hidden={{ userId }} summary={spec.summary} confirmLabel={spec.confirm} warning={spec.warning} fields={[REASON_FIELD]} idPrefix={`${kind}-`} />;
  }
  if (kind === 'disable' || kind === 'revokeSessions') {
    const spec = CONFIRMED[kind];
    return <ConfirmAction action={spec.action} hidden={{ userId }} summary={spec.summary} confirmLabel={spec.confirm} warning={spec.warning} idPrefix={`${kind}-`} />;
  }
  const spec = DIRECT[kind];
  return <ActionForm action={spec.action} fields={[]} hidden={{ userId }} submitLabel={spec.label} pendingLabel="…" variant="secondary" idPrefix={`${kind}-`} />;
}

/** Boutons de la fiche utilisateur : selon le statut et les permissions (l'API reste l'arbitre). */
export function UserActions({ userId, status, rights, flags = {} }: UserActionsProps) {
  const kinds = availableUserActions(status, rights, flags);
  if (kinds.length === 0) return null;
  return (
    <div className="flex flex-wrap items-start gap-3" role="group" aria-label="Actions sur le compte">
      {kinds.map((kind) => (
        <ActionView key={kind} kind={kind} userId={userId} />
      ))}
    </div>
  );
}
