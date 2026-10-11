import type { MailMessage } from './mailer';

/** Échappement HTML des données saisies insérées dans un message. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export interface SecurityEmailParams {
  readonly to: string;
  readonly fullName: string;
  readonly tenantName: string;
  readonly tenantSlug: string;
  readonly webUrl: string;
}

const trimSlash = (url: string): string => url.replace(/\/+$/, '');

/** Lien vers la page publique de demande de réinitialisation (aucun jeton). */
export function forgotPasswordLink(webUrl: string): string {
  return `${trimSlash(webUrl)}/mot-de-passe-oublie`;
}

/** Corps commun : paragraphes en texte brut, déclinés en HTML échappé. */
function compose(to: string, subject: string, paragraphs: readonly string[], link?: { readonly url: string; readonly label: string }): MailMessage {
  const text = [...paragraphs, ...(link ? [`${link.label} : ${link.url}`] : [])].join('\n\n');
  const html =
    paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('') +
    (link ? `<p><a href="${escapeHtml(link.url)}">${escapeHtml(link.label)}</a></p>` : '');
  return { to, subject, text, html };
}

/** Confirmation après réinitialisation : volontairement sans lien porteur de jeton. */
export function buildPasswordChangedEmail(params: SecurityEmailParams): MailMessage {
  return compose(params.to, `Votre mot de passe a été modifié — ${params.tenantName}`, [
    `Bonjour ${params.fullName},`,
    `Le mot de passe de votre compte GHMT (${params.tenantName}) vient d’être modifié. Toutes vos sessions ont été fermées.`,
    'Si vous n’êtes pas à l’origine de cette modification, contactez immédiatement l’administrateur de votre établissement.',
  ]);
}

/** Alerte au 10e échec consécutif de connexion sur un compte existant (docs/11 §5.2). */
export function buildSuspiciousLoginEmail(params: SecurityEmailParams): MailMessage {
  return compose(
    params.to,
    `Tentatives de connexion inhabituelles — ${params.tenantName}`,
    [
      `Bonjour ${params.fullName},`,
      `Plusieurs tentatives de connexion échouées ont été enregistrées sur votre compte GHMT (${params.tenantName}). Par précaution, les nouvelles tentatives sont ralenties, jusqu’à 15 minutes ; votre administrateur peut lever ce délai.`,
      'Si c’était vous, patientez ou demandez à votre administrateur de lever le délai. Si vous avez oublié votre mot de passe, vous pouvez le réinitialiser. Sinon, prévenez l’administrateur de votre établissement.',
    ],
    { url: forgotPasswordLink(params.webUrl), label: 'Réinitialiser mon mot de passe' },
  );
}

export interface MfaEmailCodeParams extends SecurityEmailParams {
  readonly code: string;
  readonly ttlMinutes: number;
}

/** Code à 6 chiffres exigé pour enrôler un second facteur hors réseau de confiance. */
export function buildMfaEmailCodeEmail(params: MfaEmailCodeParams): MailMessage {
  return compose(params.to, `Votre code de vérification — ${params.tenantName}`, [
    `Bonjour ${params.fullName},`,
    `Votre code pour activer l’authentification à deux facteurs sur GHMT (${params.tenantName}) : ${params.code}`,
    `Ce code est valable ${params.ttlMinutes} minutes. Ne le communiquez à personne ; si vous n’êtes pas à l’origine de cette demande, ignorez ce message.`,
  ]);
}

export interface MfaResetParams extends SecurityEmailParams {
  readonly actorName: string;
}

/** Information de l'utilisateur dont le second facteur a été réinitialisé par un administrateur (docs/11 §5.6). */
export function buildMfaResetEmail(params: MfaResetParams): MailMessage {
  return compose(params.to, `Votre second facteur a été réinitialisé — ${params.tenantName}`, [
    `Bonjour ${params.fullName},`,
    `L’administrateur ${params.actorName} a réinitialisé le second facteur de votre compte GHMT (${params.tenantName}). Vos sessions ont été fermées ; à votre prochaine connexion, il vous sera demandé de configurer à nouveau l’authentification à deux facteurs.`,
    'Si vous n’aviez rien demandé, signalez-le à la direction de votre établissement.',
  ]);
}
