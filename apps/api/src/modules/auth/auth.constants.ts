/** Constantes du module auth (durées en millisecondes sauf mention contraire). */
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Session : durée absolue 30 jours. */
export const SESSION_TTL_MS = 30 * DAY_MS;
/** Refresh token : 7 jours glissants, sans dépasser la session. */
export const REFRESH_TOKEN_TTL_MS = 7 * DAY_MS;
/** Rejeu réseau toléré d'un refresh token déjà consommé. */
export const REFRESH_GRACE_WINDOW_MS = 10_000;

export const MFA_CHALLENGE_TTL_MS = 5 * MINUTE_MS;
export const MFA_CHALLENGE_MAX_ATTEMPTS = 5;
export const TOTP_ISSUER = 'GHMT';
export const TOTP_KIND = 'totp';
/** Tolérance TOTP : ±1 pas de 30 s. */
export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_EPOCH_TOLERANCE_SECONDS = TOTP_PERIOD_SECONDS;

/**
 * Verrou dur : conservé UNIQUEMENT pour le realm plateforme (`platform-login.service.ts`, hors périmètre de la phase
 * durcissement). La connexion des établissements utilise le délai progressif (`LoginDelayService`).
 */
export const LOCKOUT_THRESHOLD = 5;
/** Durées de verrouillage successives (minutes), la dernière faisant plafond. */
export const LOCKOUT_MINUTES: readonly number[] = [1, 5, 15, 60];
export const MINUTE = MINUTE_MS;

/** Le compteur d'échecs de connexion expire 24 h après le dernier échec (docs/11 D3). */
export const LOGIN_FAILURE_TTL_MS = DAY_MS;
/**
 * Statuts d'établissement qui autorisent une session (connexion, refresh, mot de passe oublié) : `suspended` reste ouvert pour
 * la continuité des soins (docs/11 §14.1) ; le guard y applique le mode lecture seule des écritures non essentielles.
 */
export const SESSION_TENANT_STATUSES: ReadonlySet<string> = new Set(['active', 'suspended']);

/** Au n-ième échec consécutif d'un compte existant, un e-mail « tentatives inhabituelles » est envoyé (au plus un par 24 h). */
export const SUSPICIOUS_LOGIN_THRESHOLD = 10;
/** Depuis un réseau de confiance de l'établissement, le délai progressif est plafonné à 60 s (docs/11 décision 21). */
export const TRUSTED_NETWORK_DELAY_CAP_SECONDS = 60;
/** Audit `auth.login.delayed` : au plus un par identifiant et par heure. */
export const DELAYED_AUDIT_WINDOW_MS = 60 * MINUTE_MS;

export const PASSWORD_RESET_TTL_MS = 30 * MINUTE_MS;
/** Une nouvelle demande ne remplace pas un jeton émis il y a moins de 10 minutes (docs/11 §14.2 M2) : ni invalidation ni e-mail. */
export const PASSWORD_RESET_REISSUE_AFTER_MS = 10 * MINUTE_MS;
/** Essais de second facteur autorisés sur un jeton de réinitialisation, puis le jeton est brûlé. */
export const PASSWORD_RESET_MAX_MFA_ATTEMPTS = 5;
export const MFA_EMAIL_CODE_TTL_MS = 10 * MINUTE_MS;
export const MFA_EMAIL_CODE_MAX_ATTEMPTS = 5;
/** Une mise à jour de `last_seen_at` n'est écrite que si l'ancienne valeur a plus de 5 minutes (docs/11 D15). */
export const LAST_SEEN_REFRESH_MS = 5 * MINUTE_MS;

export const SIGNUP_THROTTLE = { default: { limit: 5, ttl: 60 * MINUTE_MS } } as const;
export const LOGIN_THROTTLE = { default: { limit: 20, ttl: 15 * MINUTE_MS } } as const;
export const MFA_VERIFY_THROTTLE = { default: { limit: 20, ttl: 15 * MINUTE_MS } } as const;
export const MFA_ACTIVATE_THROTTLE = { default: { limit: 10, ttl: 15 * MINUTE_MS } } as const;
export const INVITATION_THROTTLE = { default: { limit: 20, ttl: 15 * MINUTE_MS } } as const;
export const PASSWORD_CHANGE_THROTTLE = { default: { limit: 10, ttl: 15 * MINUTE_MS } } as const;
export const PASSWORD_FORGOT_THROTTLE = { default: { limit: 10, ttl: 15 * MINUTE_MS }, account: { limit: 3, ttl: 15 * MINUTE_MS } } as const;
export const PASSWORD_RESET_PREVIEW_THROTTLE = { default: { limit: 30, ttl: 15 * MINUTE_MS } } as const;
export const PASSWORD_RESET_THROTTLE = { default: { limit: 10, ttl: 15 * MINUTE_MS }, account: { limit: 6, ttl: 15 * MINUTE_MS } } as const;
export const MFA_EMAIL_CODE_THROTTLE = { default: { limit: 3, ttl: 15 * MINUTE_MS } } as const;
/** Envois de code e-mail par utilisateur et par fenêtre de 15 minutes (en plus du limiteur par IP). */
export const MFA_EMAIL_CODE_WINDOW_MS = 15 * MINUTE_MS;
export const MFA_EMAIL_CODE_MAX_SENDS = 3;
export const LOGOUT_THROTTLE = { default: { limit: 60, ttl: MINUTE_MS } } as const;
