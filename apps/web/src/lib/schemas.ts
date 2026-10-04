import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@ghmt/shared';
import { z } from 'zod';

/**
 * Schémas locaux au BFF en attendant leur mutualisation dans @ghmt/shared (contrats C3, C6, C7).
 */
export const FORCE_REASON_MIN = 3;
export const FORCE_REASON_MAX = 500;

export const forceReasonSchema = z
  .string()
  .trim()
  .min(FORCE_REASON_MIN, `Le motif doit comporter au moins ${String(FORCE_REASON_MIN)} caractères.`)
  .max(FORCE_REASON_MAX, `Le motif ne doit pas dépasser ${String(FORCE_REASON_MAX)} caractères.`);

const newPassword = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Le mot de passe doit comporter au moins ${String(PASSWORD_MIN_LENGTH)} caractères.`)
  .max(PASSWORD_MAX_LENGTH, `Le mot de passe ne doit pas dépasser ${String(PASSWORD_MAX_LENGTH)} caractères.`);

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Saisissez votre mot de passe actuel.').max(PASSWORD_MAX_LENGTH),
    newPassword,
  })
  .refine((v) => v.currentPassword !== v.newPassword, {
    path: ['newPassword'],
    message: 'Le nouveau mot de passe doit être différent de l\'actuel.',
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const acceptInvitationSchema = z.object({ password: newPassword });
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;

const INVITATION_TOKEN = /^[0-9A-Za-z-]{8,64}\.[0-9A-Za-z_-]{16,200}$/;

/** Jeton `<tenantId>.<secret>` : refuse tout ce qui pourrait altérer le chemin d'appel de l'API. */
export function isInvitationToken(value: string): boolean {
  return INVITATION_TOKEN.test(value);
}
