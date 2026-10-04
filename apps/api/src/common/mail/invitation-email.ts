import type { MailMessage } from './mailer';

export interface InvitationEmailParams {
  readonly to: string;
  readonly fullName: string;
  readonly tenantName: string;
  readonly webUrl: string;
  readonly token: string;
  readonly ttlHours: number;
}

/** Lien d'acceptation : `${WEB_URL}/invitation/<token>` (le jeton ne transite que par ce lien). */
export function invitationLink(webUrl: string, token: string): string {
  return `${webUrl.replace(/\/+$/, '')}/invitation/${token}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function buildInvitationEmail(params: InvitationEmailParams): MailMessage {
  const link = invitationLink(params.webUrl, params.token);
  const text = [
    `Bonjour ${params.fullName},`,
    '',
    `Un compte vous a été créé sur la plateforme GHMT de ${params.tenantName}.`,
    'Pour définir votre mot de passe et activer votre compte, ouvrez le lien suivant :',
    link,
    '',
    `Ce lien est personnel, à usage unique et valable ${params.ttlHours} heures.`,
    'Si vous n’attendiez pas cette invitation, ignorez ce message.',
  ].join('\n');
  const html =
    `<p>Bonjour ${escapeHtml(params.fullName)},</p>` +
    `<p>Un compte vous a été créé sur la plateforme GHMT de ${escapeHtml(params.tenantName)}.</p>` +
    `<p><a href="${escapeHtml(link)}">Définir mon mot de passe</a></p>` +
    `<p>Ce lien est personnel, à usage unique et valable ${params.ttlHours} heures. ` +
    'Si vous n’attendiez pas cette invitation, ignorez ce message.</p>';
  return { to: params.to, subject: `Invitation à rejoindre GHMT — ${params.tenantName}`, text, html };
}
