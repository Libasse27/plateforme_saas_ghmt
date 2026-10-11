import type { MailMessage } from './mailer';
import { escapeHtml } from './security-emails';

export interface PasswordResetEmailParams {
  readonly to: string;
  readonly fullName: string;
  readonly tenantName: string;
  readonly tenantSlug: string;
  readonly webUrl: string;
  readonly token: string;
  readonly ttlMinutes: number;
}

/** Lien de réinitialisation : `${WEB_URL}/reinitialiser/<token>` (le jeton ne transite que par ce lien, jamais journalisé). */
export function passwordResetLink(webUrl: string, token: string): string {
  return `${webUrl.replace(/\/+$/, '')}/reinitialiser/${token}`;
}

export function buildPasswordResetEmail(params: PasswordResetEmailParams): MailMessage {
  const link = passwordResetLink(params.webUrl, params.token);
  const text = [
    `Bonjour ${params.fullName},`,
    '',
    `Une réinitialisation du mot de passe de votre compte GHMT (${params.tenantName}) a été demandée.`,
    'Pour choisir un nouveau mot de passe, ouvrez le lien suivant :',
    link,
    '',
    `Code établissement : ${params.tenantSlug}`,
    '',
    `Ce lien est personnel, à usage unique et valable ${params.ttlMinutes} minutes.`,
    'Si vous n’êtes pas à l’origine de cette demande, ignorez ce message : votre mot de passe actuel reste inchangé.',
  ].join('\n');
  const html =
    `<p>Bonjour ${escapeHtml(params.fullName)},</p>` +
    `<p>Une réinitialisation du mot de passe de votre compte GHMT (${escapeHtml(params.tenantName)}) a été demandée.</p>` +
    `<p><a href="${escapeHtml(link)}">Choisir un nouveau mot de passe</a></p>` +
    `<p>Code établissement : <strong>${escapeHtml(params.tenantSlug)}</strong></p>` +
    `<p>Ce lien est personnel, à usage unique et valable ${params.ttlMinutes} minutes. ` +
    'Si vous n’êtes pas à l’origine de cette demande, ignorez ce message : votre mot de passe actuel reste inchangé.</p>';
  return { to: params.to, subject: `Réinitialisation de votre mot de passe — ${params.tenantName}`, text, html };
}
