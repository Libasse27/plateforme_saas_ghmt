'use server';

import { currentNetworkCidr, policyForm, removeNetworkForm, transferOwnerForm, trustedNetworkForm } from '@/lib/domain/security-forms';
import { toSecurityPolicy } from '@/lib/domain/security';
import { formDataToFlat, publicValues, type FormState } from '@/lib/forms';
import { actionApi } from '@/server/api';
import { checked } from './admin-common';
import { failureState } from './helpers';
import { runStepUpMutation, withoutTotpCode } from './step-up';

const SECURITY_PATH = '/administration/securite';
const USERS_PATH = '/administration/utilisateurs';
const NETWORKS_API = '/iam/security/trusted-networks';

/**
 * Toutes les opérations de pouvoir (docs/11 §14.1) sont réservées à l'administrateur principal et exigent le code
 * du second facteur, transmis dans le corps de la requête (même pour DELETE).
 */

/** Politique MFA des soignants (docs/11 D6) : deux modes seulement, aucun mode « désactivé ». */
export async function updateSecurityPolicyAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const values = withoutTotpCode(publicValues(flat));
  const valid = checked(policyForm(flat), values);
  if ('state' in valid) return valid.state;
  return runStepUpMutation({ path: '/iam/security/policy', method: 'PATCH', body: valid.data, values, revalidate: [SECURITY_PATH], message: 'Politique d\'authentification enregistrée.' });
}

/**
 * « Ajouter ce réseau » : l'adresse courante est relue auprès de l'API (la seule à connaître l'IP vue par le serveur),
 * jamais acceptée telle quelle du navigateur.
 */
async function currentIpInput(flat: Record<string, string>): Promise<{ readonly cidr: string } | { readonly state: FormState }> {
  try {
    const policy = toSecurityPolicy((await actionApi(`/iam/security/policy`)).data);
    const cidr = currentNetworkCidr(policy.requestIp);
    return cidr ? { cidr } : { state: { ok: false, message: 'Votre adresse actuelle n\'est pas connue du serveur : saisissez la plage à la main.', values: withoutTotpCode(publicValues(flat)) } };
  } catch (error) {
    return { state: failureState(error, withoutTotpCode(publicValues(flat))) };
  }
}

export async function addTrustedNetworkAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  let input: Record<string, string | undefined> = flat;
  if (flat.useCurrentIp === '1') {
    const current = await currentIpInput(flat);
    if ('state' in current) return current.state;
    input = { ...flat, cidr: current.cidr };
  }
  const values = withoutTotpCode(publicValues(flat));
  const valid = checked(trustedNetworkForm(input), values);
  if ('state' in valid) return valid.state;
  return runStepUpMutation({ path: NETWORKS_API, method: 'POST', body: valid.data, values, revalidate: [SECURITY_PATH], message: 'Plage réseau ajoutée.' });
}

export async function removeTrustedNetworkAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const valid = checked(removeNetworkForm(formDataToFlat(formData)), {});
  if ('state' in valid) return valid.state;
  const { networkId, totpCode } = valid.data;
  return runStepUpMutation({ path: `${NETWORKS_API}/${networkId}`, method: 'DELETE', body: { totpCode }, revalidate: [SECURITY_PATH], message: 'Plage réseau supprimée.' });
}

/** Transfert de l'administrateur principal (docs/11 D9) : l'API vérifie que l'appelant est le principal. */
export async function transferOwnershipAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const valid = checked(transferOwnerForm(flat), {});
  if ('state' in valid) return valid.state;
  return runStepUpMutation({ path: '/iam/security/owner', method: 'POST', body: valid.data, revalidate: [SECURITY_PATH, USERS_PATH], message: 'Le titre d\'administrateur principal a été transféré.' });
}
