/**
 * Contrats d'entrée de l'API (Zod), partagés par l'API, le web, le desktop et le mobile.
 */
import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, PRIVILEGED_PASSWORD_MIN_LENGTH } from './password';
import { email, isoDateTime, uuid } from './primitives';

export const ESTABLISHMENT_TYPES = [
  'hospital_n1',
  'hospital_n2',
  'hospital_n3',
  'medicalized_center',
  'health_center',
  'clinic',
  'private_practice',
  'laboratory',
  'pharmacy',
  'diagnostic_center',
  'specialized_center',
  'other',
] as const;
export type EstablishmentType = (typeof ESTABLISHMENT_TYPES)[number];

export const CURRENCIES = ['XOF', 'XAF', 'CDF', 'USD', 'EUR'] as const;

export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, PRIVILEGED_PASSWORD_MIN_LENGTH } from './password';

const slug = z
  .string()
  .min(3)
  .max(48)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'slug: minuscules, chiffres et tirets');

// ───────── Onboarding / tenancy ─────────
export const signupTenantSchema = z.object({
  establishment: z.object({
    slug,
    legalName: z.string().min(2).max(200),
    tradeName: z.string().min(2).max(200).optional(),
    establishmentType: z.enum(ESTABLISHMENT_TYPES),
    countryCode: z.string().length(2).toUpperCase(),
    baseCurrency: z.enum(CURRENCIES),
    timezone: z.string().min(3).max(64).default('Africa/Dakar'),
  }),
  mainSite: z.object({
    code: z.string().min(1).max(20),
    name: z.string().min(2).max(200),
    city: z.string().max(100).optional(),
  }),
  admin: z.object({
    fullName: z.string().min(2).max(200),
    email,
    password: z.string().min(PRIVILEGED_PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
  }),
});
export type SignupTenantInput = z.infer<typeof signupTenantSchema>;

// ───────── Auth ─────────
export const loginSchema = z.object({
  tenantSlug: slug,
  email,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const mfaVerifySchema = z.object({
  challengeId: z.string().min(16).max(128),
  code: z.string().regex(/^(\d{6}|[A-Z2-9]{10})$/, 'code TOTP (6 chiffres) ou code de secours'),
});
export type MfaVerifyInput = z.infer<typeof mfaVerifySchema>;

export const totpActivateSchema = z.object({ code: z.string().regex(/^\d{6}$/) });

export const refreshSchema = z.object({ refreshToken: z.string().min(32).max(256).optional() });

// ───────── Organisation ─────────
export const createSiteSchema = z.object({
  code: z.string().min(1).max(20),
  name: z.string().min(2).max(200),
  city: z.string().max(100).optional(),
  countryCode: z.string().length(2).toUpperCase().optional(),
  timezone: z.string().max(64).optional(),
});
export const updateSiteSchema = createSiteSchema.partial();

export const createDepartmentSchema = z.object({
  siteId: uuid,
  parentId: uuid.optional(),
  code: z.string().min(1).max(20),
  name: z.string().min(2).max(200),
  kind: z.enum(['clinical', 'medico_technical', 'administrative', 'support']).default('clinical'),
});
export const updateDepartmentSchema = createDepartmentSchema.omit({ siteId: true }).partial();

// ───────── IAM ─────────
export const SCOPE_TYPES = ['tenant', 'site', 'department'] as const;
export type ScopeType = (typeof SCOPE_TYPES)[number];

export const createAssignmentSchema = z
  .object({
    roleId: uuid,
    scopeType: z.enum(SCOPE_TYPES),
    scopeId: uuid.optional(),
    validUntil: isoDateTime.optional(),
  })
  .refine((v) => (v.scopeType === 'tenant') === (v.scopeId === undefined), {
    message: 'scopeId requis pour une portée site/service, interdit pour la portée établissement',
    path: ['scopeId'],
  });
export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>;

export const createUserSchema = z.object({
  fullName: z.string().min(2).max(200),
  email,
  locale: z.enum(['fr', 'en']).default('fr'),
  roleAssignments: z.array(createAssignmentSchema).max(20).default([]),
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

// ───────── Praticiens & rendez-vous ─────────
export const createPractitionerSchema = z.object({
  fullName: z.string().min(2).max(200),
  userId: uuid.optional(),
  specialty: z.string().max(100).optional(),
  departmentId: uuid.optional(),
  primarySiteId: uuid.optional(),
  licenseNumber: z.string().max(50).optional(),
  defaultConsultMinutes: z.number().int().min(5).max(240).default(20),
  isBookable: z.boolean().default(true),
});
export type CreatePractitionerInput = z.infer<typeof createPractitionerSchema>;

export const APPOINTMENT_STATUSES = [
  'requested',
  'scheduled',
  'confirmed',
  'checked_in',
  'in_progress',
  'completed',
  'cancelled',
  'no_show',
] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

const endsAfterStarts = (v: { startsAt: string; endsAt: string }): boolean =>
  new Date(v.endsAt) > new Date(v.startsAt);
const endsAfterStartsIssue = { message: 'endsAt doit être postérieur à startsAt', path: ['endsAt'] };

export const createAppointmentSchema = z
  .object({
    patientId: uuid,
    practitionerId: uuid,
    siteId: uuid,
    startsAt: isoDateTime,
    endsAt: isoDateTime,
    reason: z.string().max(500).optional(),
    source: z.enum(['front_desk', 'phone', 'mobile_app', 'web']).default('front_desk'),
  })
  .refine(endsAfterStarts, endsAfterStartsIssue);
export type CreateAppointmentInput = z.infer<typeof createAppointmentSchema>;

export const rescheduleAppointmentSchema = z
  .object({ startsAt: isoDateTime, endsAt: isoDateTime })
  .refine(endsAfterStarts, endsAfterStartsIssue);
export type RescheduleAppointmentInput = z.infer<typeof rescheduleAppointmentSchema>;

export const changeAppointmentStatusSchema = z.object({
  status: z.enum(APPOINTMENT_STATUSES),
  cancelReason: z.string().max(500).optional(),
});
export type ChangeAppointmentStatusInput = z.infer<typeof changeAppointmentStatusSchema>;

export const listAppointmentsSchema = z.object({
  from: isoDateTime,
  to: isoDateTime,
  practitionerId: uuid.optional(),
  siteId: uuid.optional(),
  patientId: uuid.optional(),
  status: z.enum(APPOINTMENT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
export type ListAppointmentsInput = z.infer<typeof listAppointmentsSchema>;

// ───────── Commun ─────────
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().max(200).optional(),
});

// Schémas par module : chaque équipe n'édite que son propre fichier.
export * from './auth';
export * from './org';
export * from './iam';
export * from './patients';
export * from './appointments';
