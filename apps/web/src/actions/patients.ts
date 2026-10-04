'use server';

import { redirect } from 'next/navigation';
import { createPatientSchema } from '@ghmt/shared';
import { isApiError } from '@/lib/api/errors';
import { parseMe } from '@/lib/auth/me';
import { fieldErrorsFromZod, formDataToFlat, nestFlat, publicValues, type FormState } from '@/lib/forms';
import { parseCandidatesJson, toList, toPatient } from '@/lib/domain/mappers';
import { normalizePhone } from '@/lib/domain/phone';
import { buildSearchBody } from '@/lib/domain/patient-search';
import { forceReasonSchema } from '@/lib/schemas';
import { actionApi } from '@/server/api';
import { failureState, invalidState } from './helpers';

/** Champs du formulaire qui ne font pas partie du schéma patient (traités séparément). */
const NON_PATIENT_FIELDS: ReadonlySet<string> = new Set(['force', 'forceReason', 'candidatesJson', 'phone']);

async function tenantCountryCode(): Promise<string> {
  return parseMe((await actionApi('/auth/me')).data).tenant.countryCode;
}

/**
 * Création d'un patient. Sur doublon suspecté (409 patient_duplicate), le formulaire propose de
 * « créer quand même » : `force=1` + motif, transmis en `?force=true` avec `forceReason` (C3).
 */
export async function createPatientAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const values = publicValues(flat);
  const fields = Object.fromEntries(Object.entries(flat).filter(([key]) => !NON_PATIENT_FIELDS.has(key)));
  const force = flat.force === '1';
  const phoneErrors: Record<string, string> = {};
  let phone: string | undefined;

  try {
    if (flat.phone?.trim()) {
      const normalized = normalizePhone(flat.phone, await tenantCountryCode());
      if (normalized.ok) phone = normalized.e164;
      else phoneErrors.phone = normalized.error;
    }

    const parsed = createPatientSchema.safeParse({
      ...nestFlat(fields),
      birthDateEstimated: flat.birthDateEstimated === 'on',
      ...(phone ? { phone } : {}),
    });
    const errors = { ...(parsed.success ? {} : fieldErrorsFromZod(parsed.error)), ...phoneErrors };

    const reason = force ? forceReasonSchema.safeParse(flat.forceReason ?? '') : null;
    if (reason && !reason.success) errors.forceReason = reason.error.issues[0]?.message ?? 'Motif invalide.';

    if (!parsed.success || Object.keys(errors).length > 0) {
      const invalid = invalidState(errors, values);
      return force ? { ...invalid, extra: { candidates: parseCandidatesJson(flat.candidatesJson), forceable: true } } : invalid;
    }

    const { data } = await actionApi('/patients', {
      method: 'POST',
      ...(reason?.success ? { query: { force: true }, body: { ...parsed.data, forceReason: reason.data } } : { body: parsed.data }),
    });
    const patientId = toPatient(data).id;
    redirect(patientId ? `/patients/${encodeURIComponent(patientId)}` : '/patients');
  } catch (error) {
    if (isApiError(error)) return failureState(error, values);
    throw error;
  }
}

/**
 * Recherche de patients (C1) : POST, donc aucun terme dans l'URL. Le curseur est opaque, issu de la
 * réponse précédente. Le résultat est renvoyé dans l'état (client minimal).
 */
export async function searchPatientsAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const flat = formDataToFlat(formData);
  const values = { q: flat.q ?? '' };
  try {
    const built = buildSearchBody(flat.q, await tenantCountryCode(), flat.cursor || undefined);
    if (!built.ok) return { ok: false, message: built.error, values };
    const { data, meta } = await actionApi('/patients/search', { method: 'POST', body: built.body });
    const pagination = meta.pagination;
    return {
      ok: true,
      values,
      extra: {
        patients: toList(data, toPatient),
        nextCursor: pagination?.hasMore ? (pagination.nextCursor ?? null) : null,
        paged: Boolean(flat.cursor),
      },
    };
  } catch (error) {
    return failureState(error, values);
  }
}
