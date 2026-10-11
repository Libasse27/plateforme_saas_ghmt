import { isClinicalPermission, type ClinicalMfaMode } from '@ghmt/shared';
import type { EffectiveGrant } from './authorization.types';

export interface ClinicalMfaContext {
  readonly grants: readonly EffectiveGrant[];
  readonly mode: ClinicalMfaMode;
  /** L'IP cliente de CETTE requête appartient-elle à une plage de confiance active ? */
  readonly networkTrusted: boolean;
}

/** Rôle clinique = au moins une permission des modules cliniques, calculée sur les permissions effectives (docs/11 D5). */
export function hasClinicalGrant(grants: readonly EffectiveGrant[]): boolean {
  return grants.some((grant) => isClinicalPermission(grant.permission));
}

/** Règle D6 : un soignant doit avoir une session vérifiée par MFA hors réseau de confiance (ou partout en mode `always`). */
export function clinicalMfaRequired(context: ClinicalMfaContext): boolean {
  return hasClinicalGrant(context.grants) && (context.mode === 'always' || !context.networkTrusted);
}

/** MFA exigée de l'utilisateur : rôle `mfaRequired` (partout) ou règle clinique. Utilisée par le guard, `/auth/me` et la connexion. */
export function mfaRequiredFor(context: ClinicalMfaContext): boolean {
  return context.grants.some((grant) => grant.mfaRequired) || clinicalMfaRequired(context);
}
