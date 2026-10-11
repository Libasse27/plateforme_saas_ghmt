import type { MailMessage } from './mailer';

export interface SignupVerificationEmailParams {
  readonly to: string;
  readonly tenantSlug: string;
  readonly webUrl: string;
  readonly token: string;
  readonly ttlHours: number;
}

/** Lien de confirmation : `${WEB_URL}/inscription/confirmer/<token>` (le jeton ne transite que par ce lien). */
export function signupVerificationLink(webUrl: string, token: string): string {
  return `${webUrl.replace(/\/+$/, '')}/inscription/confirmer/${token}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * E-mail de vérification de l'adresse de l'administrateur fondateur. Ne jamais le journaliser (jeton).
 * Libellé FIXE (docs/11 §14.3.4) : ni nom d'établissement ni nom de personne saisis à l'inscription, afin qu'un
 * tiers ne puisse pas faire envoyer un message de son choix à l'adresse d'une victime.
 */
export function buildSignupVerificationEmail(params: SignupVerificationEmailParams): MailMessage {
  const link = signupVerificationLink(params.webUrl, params.token);
  const text = [
    'Bonjour,',
    '',
    'Une inscription d’établissement a été demandée avec cette adresse sur la plateforme GHMT.',
    'Pour confirmer votre adresse e-mail et activer l’établissement, ouvrez le lien suivant :',
    link,
    '',
    `Code établissement à saisir à la connexion : ${params.tenantSlug}`,
    '',
    `Ce lien est personnel, à usage unique et valable ${params.ttlHours} heures.`,
    'Si vous n’êtes pas à l’origine de cette inscription, ignorez ce message : l’établissement ne sera pas activé.',
  ].join('\n');
  const html =
    '<p>Bonjour,</p>' +
    '<p>Une inscription d’établissement a été demandée avec cette adresse sur la plateforme GHMT.</p>' +
    `<p><a href="${escapeHtml(link)}">Confirmer mon adresse e-mail</a></p>` +
    `<p>Code établissement à saisir à la connexion : <strong>${escapeHtml(params.tenantSlug)}</strong></p>` +
    `<p>Ce lien est personnel, à usage unique et valable ${params.ttlHours} heures. ` +
    'Si vous n’êtes pas à l’origine de cette inscription, ignorez ce message : l’établissement ne sera pas activé.</p>';
  return { to: params.to, subject: 'Confirmez votre inscription à GHMT', text, html };
}
