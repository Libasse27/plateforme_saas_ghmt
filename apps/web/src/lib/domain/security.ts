import { bool, items, rec, str, strOrNull } from './raw';

/**
 * Mappeurs tolérants de la sécurité de l'établissement (docs/11 §5.4). Aucun import de `schemas/security.ts` :
 * le front code contre le contrat, sans dépendre de l'avancement de l'équipe AUTH.
 */

export const CLINICAL_MFA_MODES = ['off_network', 'always'] as const;
export type ClinicalMfaMode = (typeof CLINICAL_MFA_MODES)[number];

export const CLINICAL_MFA_LABELS: Readonly<Record<ClinicalMfaMode, string>> = {
  off_network: 'Hors du réseau de l\'établissement seulement',
  always: 'Toujours, même depuis le réseau de l\'établissement',
};

export interface PersonRef {
  readonly id: string;
  readonly fullName: string;
}

export interface TrustedNetworkView {
  readonly id: string;
  readonly cidr: string;
  readonly label: string;
  readonly siteId: string | null;
  readonly createdAt: string;
  readonly createdBy: PersonRef | null;
}

export interface SecurityPolicyView {
  readonly clinicalMfa: ClinicalMfaMode;
  readonly trustedNetworks: readonly TrustedNetworkView[];
  readonly requestIp: string | null;
  readonly requestIpTrusted: boolean;
  readonly owner: PersonRef | null;
  readonly updatedAt: string | null;
  /** Vrai pour l'administrateur principal seul (docs/11 §14.1) ; null tant que l'API ne le précise pas. */
  readonly canManage: boolean | null;
  /** Utilisateurs actifs à rôle clinique sans second facteur actif. */
  readonly clinicalUsersWithoutMfa: number;
}

function toPersonRef(raw: unknown): PersonRef | null {
  const data = rec(raw);
  const id = str(data.id);
  return id ? { id, fullName: str(data.fullName) || 'Utilisateur' } : null;
}

export function toTrustedNetwork(raw: unknown): TrustedNetworkView {
  const data = rec(raw);
  return {
    id: str(data.id),
    cidr: str(data.cidr),
    label: str(data.label),
    siteId: strOrNull(data.siteId),
    createdAt: str(data.createdAt),
    createdBy: toPersonRef(data.createdBy),
  };
}

function toMode(value: unknown): ClinicalMfaMode {
  return CLINICAL_MFA_MODES.find((mode) => mode === value) ?? 'off_network';
}

export function toSecurityPolicy(raw: unknown): SecurityPolicyView {
  const data = rec(raw);
  return {
    clinicalMfa: toMode(data.clinicalMfa),
    trustedNetworks: items(data.trustedNetworks, toTrustedNetwork),
    requestIp: strOrNull(data.requestIp),
    requestIpTrusted: bool(data.requestIpTrusted),
    owner: toPersonRef(data.owner),
    updatedAt: strOrNull(data.updatedAt),
    canManage: typeof data.canManage === 'boolean' ? data.canManage : null,
    clinicalUsersWithoutMfa: typeof data.clinicalUsersWithoutMfa === 'number' && Number.isInteger(data.clinicalUsersWithoutMfa) && data.clinicalUsersWithoutMfa > 0 ? data.clinicalUsersWithoutMfa : 0,
  };
}

/** Le lecteur (ou l'utilisateur cible) est-il l'administrateur principal de l'établissement ? */
export function isOwnerOf(policy: Pick<SecurityPolicyView, 'owner'> | null, userId: string): boolean {
  return policy?.owner != null && userId !== '' && policy.owner.id === userId;
}
