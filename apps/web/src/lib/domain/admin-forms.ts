import {
  createAssignmentSchema,
  createDepartmentSchema,
  createPractitionerSchema,
  createRoleSchema,
  createSiteSchema,
  createUserSchema,
  updateDepartmentSchema,
  updatePractitionerSchema,
  updateRoleSchema,
  updateSiteSchema,
} from '@ghmt/shared';
import type { ZodType } from 'zod';
import { fieldErrorsFromZod } from '../forms';
import { isDayString } from '../format/dates';

/** Validations locales des formulaires d'administration : on réutilise les schémas partagés existants (org, iam, praticiens). */

export type FormResult<T> = { readonly ok: true; readonly data: T } | { readonly ok: false; readonly errors: Record<string, string> };

type Flat = Readonly<Record<string, string | undefined>>;
export type Mode = 'create' | 'update';

function clean(flat: Flat, keys: readonly string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of keys) {
    const value = flat[key]?.trim();
    if (value) result[key] = value;
  }
  return result;
}

function parse<T>(schema: ZodType<T>, input: unknown, remap: (errors: Record<string, string>) => Record<string, string> = (e) => e): FormResult<T> {
  const parsed = schema.safeParse(input);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, errors: remap(fieldErrorsFromZod(parsed.error)) };
}

export function siteForm(flat: Flat, mode: Mode): FormResult<Record<string, unknown>> {
  const input = clean(flat, ['code', 'name', 'city', 'countryCode', 'timezone']);
  return parse((mode === 'create' ? createSiteSchema : updateSiteSchema) as ZodType<Record<string, unknown>>, input);
}

export function departmentForm(flat: Flat, mode: Mode): FormResult<Record<string, unknown>> {
  if (mode === 'update') return parse(updateDepartmentSchema as ZodType<Record<string, unknown>>, clean(flat, ['code', 'name', 'kind']));
  return parse(createDepartmentSchema as ZodType<Record<string, unknown>>, clean(flat, ['siteId', 'code', 'name', 'kind']));
}

const END_OF_DAY = 'T23:59:59.000Z';

/** Fin de validité saisie comme jour (AAAA-MM-JJ) : valable jusqu'à la fin de ce jour (UTC). */
export function endOfDayIso(day: string | undefined): string | null {
  return isDayString(day) ? `${day}${END_OF_DAY}` : null;
}

interface ScopeInput {
  readonly roleId: string;
  readonly scopeType: string;
  readonly scopeId?: string;
  readonly validUntil?: string;
}

function scopeTarget(flat: Flat, scopeType: string): string | undefined {
  if (scopeType === 'site') return flat.siteId?.trim() || undefined;
  if (scopeType === 'department') return flat.departmentId?.trim() || undefined;
  return undefined;
}

const SCOPE_FIELD: Readonly<Record<string, string>> = { site: 'siteId', department: 'departmentId' };

function remapScope(scopeType: string): (errors: Record<string, string>) => Record<string, string> {
  return (errors) =>
    Object.fromEntries(
      Object.entries(errors).map(([path, message]) => {
        const leaf = path.split('.').at(-1) ?? path;
        return [leaf === 'scopeId' ? (SCOPE_FIELD[scopeType] ?? 'scopeId') : leaf === 'roleId' ? 'roleId' : path, message];
      }),
    );
}

function scopeInput(flat: Flat): ScopeInput {
  const scopeType = flat.scopeType?.trim() || 'tenant';
  const scopeId = scopeTarget(flat, scopeType);
  return { roleId: flat.roleId?.trim() ?? '', scopeType, ...(scopeId ? { scopeId } : {}) };
}

export function assignmentForm(flat: Flat): FormResult<Record<string, unknown>> {
  const base = scopeInput(flat);
  const rawEnd = flat.validUntil?.trim();
  const validUntil = endOfDayIso(rawEnd);
  if (rawEnd && !validUntil) return { ok: false, errors: { validUntil: 'Date invalide (format AAAA-MM-JJ).' } };
  return parse(createAssignmentSchema as ZodType<Record<string, unknown>>, { ...base, ...(validUntil ? { validUntil } : {}) }, remapScope(base.scopeType));
}

export function inviteForm(flat: Flat): FormResult<Record<string, unknown>> {
  const base = scopeInput(flat);
  const user = { ...clean(flat, ['fullName', 'email', 'locale']), roleAssignments: base.roleId ? [base] : [] };
  return parse(createUserSchema as ZodType<Record<string, unknown>>, user, remapScope(base.scopeType));
}

export function roleForm(flat: Flat, permissions: readonly string[], mode: Mode): FormResult<Record<string, unknown>> {
  const fields = clean(flat, mode === 'create' ? ['code', 'name', 'description'] : ['name', 'description']);
  return parse((mode === 'create' ? createRoleSchema : updateRoleSchema) as ZodType<Record<string, unknown>>, { ...fields, permissions: [...permissions] });
}

export function practitionerForm(flat: Flat, mode: Mode): FormResult<Record<string, unknown>> {
  const base: Record<string, unknown> = clean(flat, ['fullName', 'specialty', 'departmentId', 'primarySiteId', 'licenseNumber']);
  const minutes = flat.defaultConsultMinutes?.trim();
  if (minutes) {
    const value = Number(minutes);
    if (!Number.isInteger(value)) return { ok: false, errors: { defaultConsultMinutes: 'Saisissez un nombre entier de minutes.' } };
    base.defaultConsultMinutes = value;
  }
  base.isBookable = flat.isBookable !== undefined;
  if (mode === 'create') return parse(createPractitionerSchema as ZodType<Record<string, unknown>>, { ...base, ...clean(flat, ['userId']) });
  return parse(updatePractitionerSchema as ZodType<Record<string, unknown>>, base);
}
