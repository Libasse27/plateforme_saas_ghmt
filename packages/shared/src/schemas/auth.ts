/**
 * Schémas et contrats propres au module auth.
 * Chaque équipe de module n'édite que son propre fichier ; les schémas communs restent dans ./index.ts
 * (signupTenantSchema, loginSchema, mfaVerifySchema, totpActivateSchema).
 */
import { z } from 'zod';
import { PASSWORD_MAX_LENGTH, passwordSchema } from './password';

/** Jeton de rafraîchissement opaque `<tenantId>.<secret>`, obligatoire dans le corps de la requête. */
export const refreshRequestSchema = z.object({ refreshToken: z.string().min(32).max(256) });
export type RefreshRequestInput = z.infer<typeof refreshRequestSchema>;

export const MFA_METHODS = ['totp', 'backup_code'] as const;
export type MfaMethod = (typeof MFA_METHODS)[number];

export interface SignupResponse {
  readonly tenantId: string;
  readonly slug: string;
}

/** Paire de jetons émise par login, mfa/verify et refresh. */
export interface AuthTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  /** Durée de vie du jeton d'accès, en secondes. */
  readonly expiresIn: number;
}

export interface SessionTokens extends AuthTokens {
  readonly mfaEnrolled: boolean;
  /** Un rôle de l'utilisateur exige la MFA. */
  readonly mfaRequired: boolean;
}

export interface MfaChallengeResponse {
  readonly mfaRequired: true;
  readonly challengeId: string;
  readonly methods: readonly MfaMethod[];
}

export type LoginResponse = SessionTokens | MfaChallengeResponse;

/** Déconnexion : le jeton de rafraîchissement permet de révoquer sa session sans jeton d'accès valide (C8). */
export const logoutSchema = z.object({ refreshToken: z.string().min(32).max(256).optional() });
export type LogoutInput = z.infer<typeof logoutSchema>;

/** Acceptation d'invitation : l'utilisateur choisit son mot de passe (C6). */
export const acceptInvitationSchema = z.object({ password: passwordSchema });
export type AcceptInvitationInput = z.infer<typeof acceptInvitationSchema>;

/** Changement de mot de passe de l'utilisateur connecté (C7). */
export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: passwordSchema,
});
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

/** Aperçu public d'une invitation (GET /auth/invitations/:token). */
export interface InvitationPreview {
  readonly email: string;
  readonly fullName: string;
  readonly tenantName: string;
}

export interface TenantProfile {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly timezone: string;
  readonly countryCode: string;
  readonly baseCurrency: string;
}

export interface MeResponse {
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly fullName: string;
    readonly locale: string;
    readonly mustChangePassword: boolean;
  };
  readonly tenant: TenantProfile;
  readonly permissions: readonly string[];
  readonly modules: readonly string[];
  readonly mfa: { readonly enrolled: boolean; readonly verified: boolean; readonly required: boolean };
}

export interface SessionSummary {
  readonly id: string;
  readonly current: boolean;
  readonly userAgent: string | null;
  readonly ip: string | null;
  readonly mfaVerified: boolean;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
}

export interface TotpSetupResponse {
  readonly otpauthUrl: string;
  readonly secret: string;
}

export interface TotpActivateResponse {
  readonly accessToken: string;
  readonly expiresIn: number;
  /** Affichés une seule fois. */
  readonly backupCodes: readonly string[];
}
