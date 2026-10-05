'use server';

import { toChainVerification, verificationMessage } from '@/lib/domain/audit';
import type { FormState } from '@/lib/forms';
import { actionApi } from '@/server/api';
import { failureState } from './helpers';

/** Vérification d'intégrité de la chaîne d'audit (lecture auditée côté API ; 3 requêtes par minute). */
export async function verifyAuditChainAction(): Promise<FormState> {
  try {
    const verification = toChainVerification((await actionApi('/audit-logs/verify')).data);
    return { ok: verification.status === 'intact' || verification.status === 'empty', message: verificationMessage(verification), extra: { verification } };
  } catch (error) {
    return failureState(error);
  }
}
