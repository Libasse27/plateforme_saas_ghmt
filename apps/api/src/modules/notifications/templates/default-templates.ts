import type { NotificationChannel, NotificationLocale, NotificationTypeCode } from '@ghmt/shared';

/**
 * Modèles par défaut, versionnés EN CODE (docs/10 D12) : version entière par modèle, incrémentée à chaque évolution du texte.
 * Aucun terme clinique, aucun nom de service, aucun lien dans les messages patients ; les SMS restent en GSM-7
 * (pas de ê, ç, î, ô, û, â) pour tenir sur peu de segments même sans translittération.
 */
export interface DefaultTemplate {
  readonly typeCode: NotificationTypeCode;
  readonly channel: NotificationChannel;
  readonly locale: NotificationLocale;
  readonly version: number;
  /** `null` pour un SMS. */
  readonly subject: string | null;
  readonly body: string;
}

const V1 = 1;
const t = (typeCode: NotificationTypeCode, channel: NotificationChannel, locale: NotificationLocale, subject: string | null, body: string): DefaultTemplate => ({
  typeCode,
  channel,
  locale,
  version: V1,
  subject,
  body,
});

const SIGNATURE_FR = '\n\nCordialement,\n{{etablissement.nom}}';
const SIGNATURE_EN = '\n\nKind regards,\n{{etablissement.nom}}';
const STOP_FR = ' Repondez STOP pour ne plus recevoir de rappels.';
const STOP_EN = ' Reply STOP to stop receiving reminders.';

const APPOINTMENT_SMS: readonly DefaultTemplate[] = [
  t('appointment.confirmed', 'sms', 'fr', null, '{{etablissement.nom}} : rendez-vous confirmé le {{rdv.date}} à {{rdv.heure}} ({{site.nom}}).'),
  t('appointment.confirmed', 'sms', 'en', null, '{{etablissement.nom}}: appointment confirmed on {{rdv.date}} at {{rdv.heure}} ({{site.nom}}).'),
  t('appointment.rescheduled', 'sms', 'fr', null, '{{etablissement.nom}} : votre rendez-vous est déplacé au {{rdv.date}} à {{rdv.heure}} ({{site.nom}}).'),
  t('appointment.rescheduled', 'sms', 'en', null, '{{etablissement.nom}}: your appointment has moved to {{rdv.date}} at {{rdv.heure}} ({{site.nom}}).'),
  t('appointment.cancelled', 'sms', 'fr', null, '{{etablissement.nom}} : votre rendez-vous du {{rdv.date}} à {{rdv.heure}} est annulé. Contactez-nous pour en fixer un autre.'),
  t('appointment.cancelled', 'sms', 'en', null, '{{etablissement.nom}}: your appointment on {{rdv.date}} at {{rdv.heure}} is cancelled. Contact us to book another.'),
  t('appointment.reminder_d1', 'sms', 'fr', null, `{{etablissement.nom}} : rappel, rendez-vous demain, {{rdv.date}} à {{rdv.heure}} ({{site.nom}}).${STOP_FR}`),
  t('appointment.reminder_d1', 'sms', 'en', null, `{{etablissement.nom}}: reminder, appointment tomorrow, {{rdv.date}} at {{rdv.heure}} ({{site.nom}}).${STOP_EN}`),
  t('appointment.reminder_h2', 'sms', 'fr', null, `{{etablissement.nom}} : rappel, rendez-vous aujourd'hui à {{rdv.heure}} ({{site.nom}}).${STOP_FR}`),
  t('appointment.reminder_h2', 'sms', 'en', null, `{{etablissement.nom}}: reminder, appointment today at {{rdv.heure}} ({{site.nom}}).${STOP_EN}`),
];

const APPOINTMENT_EMAIL: readonly DefaultTemplate[] = [
  t('appointment.confirmed', 'email', 'fr', 'Rendez-vous confirmé le {{rdv.date}}', `Bonjour {{patient.prenom}},\n\nVotre rendez-vous est confirmé le {{rdv.date}} à {{rdv.heure}}, sur le site {{site.nom}}.${SIGNATURE_FR}`),
  t('appointment.confirmed', 'email', 'en', 'Appointment confirmed on {{rdv.date}}', `Hello {{patient.prenom}},\n\nYour appointment is confirmed on {{rdv.date}} at {{rdv.heure}}, at {{site.nom}}.${SIGNATURE_EN}`),
  t('appointment.rescheduled', 'email', 'fr', 'Rendez-vous déplacé au {{rdv.date}}', `Bonjour {{patient.prenom}},\n\nVotre rendez-vous est déplacé au {{rdv.date}} à {{rdv.heure}}, sur le site {{site.nom}}.${SIGNATURE_FR}`),
  t('appointment.rescheduled', 'email', 'en', 'Appointment moved to {{rdv.date}}', `Hello {{patient.prenom}},\n\nYour appointment has moved to {{rdv.date}} at {{rdv.heure}}, at {{site.nom}}.${SIGNATURE_EN}`),
  t('appointment.cancelled', 'email', 'fr', 'Rendez-vous annulé', `Bonjour {{patient.prenom}},\n\nVotre rendez-vous du {{rdv.date}} à {{rdv.heure}} est annulé. N'hésitez pas à nous contacter pour en fixer un autre.${SIGNATURE_FR}`),
  t('appointment.cancelled', 'email', 'en', 'Appointment cancelled', `Hello {{patient.prenom}},\n\nYour appointment on {{rdv.date}} at {{rdv.heure}} is cancelled. Please contact us to book another.${SIGNATURE_EN}`),
  t('appointment.reminder_d1', 'email', 'fr', 'Rappel : rendez-vous demain', `Bonjour {{patient.prenom}},\n\nNous vous rappelons votre rendez-vous demain, {{rdv.date}} à {{rdv.heure}}, sur le site {{site.nom}}.${SIGNATURE_FR}`),
  t('appointment.reminder_d1', 'email', 'en', 'Reminder: appointment tomorrow', `Hello {{patient.prenom}},\n\nThis is a reminder of your appointment tomorrow, {{rdv.date}} at {{rdv.heure}}, at {{site.nom}}.${SIGNATURE_EN}`),
  t('appointment.reminder_h2', 'email', 'fr', 'Rappel : rendez-vous aujourd’hui à {{rdv.heure}}', `Bonjour {{patient.prenom}},\n\nNous vous rappelons votre rendez-vous aujourd'hui à {{rdv.heure}}, sur le site {{site.nom}}.${SIGNATURE_FR}`),
  t('appointment.reminder_h2', 'email', 'en', 'Reminder: appointment today at {{rdv.heure}}', `Hello {{patient.prenom}},\n\nThis is a reminder of your appointment today at {{rdv.heure}}, at {{site.nom}}.${SIGNATURE_EN}`),
];

const INVOICE_PAY_FR = '\n\nRèglement en ligne : {{lien}}';
const INVOICE_PAY_EN = '\n\nPay online: {{lien}}';

const SUBSCRIPTION_EMAIL: readonly DefaultTemplate[] = [
  t('subscription.invoice_issued', 'email', 'fr', 'Facture {{facture.numero}} à régler', `Bonjour,\n\nLa facture {{facture.numero}} de {{facture.montant}} a été émise pour {{etablissement.nom}}. Échéance : {{facture.echeance}}.${INVOICE_PAY_FR}`),
  t('subscription.invoice_issued', 'email', 'en', 'Invoice {{facture.numero}} to pay', `Hello,\n\nInvoice {{facture.numero}} for {{facture.montant}} has been issued to {{etablissement.nom}}. Due date: {{facture.echeance}}.${INVOICE_PAY_EN}`),
  t('subscription.payment_reminder', 'email', 'fr', 'Rappel : facture {{facture.numero}} à échéance le {{facture.echeance}}', `Bonjour,\n\nLa facture {{facture.numero}} de {{facture.montant}} pour {{etablissement.nom}} arrive à échéance le {{facture.echeance}}.${INVOICE_PAY_FR}`),
  t('subscription.payment_reminder', 'email', 'en', 'Reminder: invoice {{facture.numero}} due on {{facture.echeance}}', `Hello,\n\nInvoice {{facture.numero}} for {{facture.montant}} ({{etablissement.nom}}) is due on {{facture.echeance}}.${INVOICE_PAY_EN}`),
  t('subscription.payment_overdue', 'email', 'fr', 'Facture {{facture.numero}} en retard', `Bonjour,\n\nLa facture {{facture.numero}} de {{facture.montant}} pour {{etablissement.nom}} est en retard de {{facture.jours_retard}} jour(s). Merci de la régler pour éviter toute interruption de service.${INVOICE_PAY_FR}`),
  t('subscription.payment_overdue', 'email', 'en', 'Invoice {{facture.numero}} overdue', `Hello,\n\nInvoice {{facture.numero}} for {{facture.montant}} ({{etablissement.nom}}) is {{facture.jours_retard}} day(s) overdue. Please pay it to avoid any service interruption.${INVOICE_PAY_EN}`),
  t('subscription.suspension_notice', 'email', 'fr', 'Avis de suspension : facture {{facture.numero}}', `Bonjour,\n\nSans règlement de la facture {{facture.numero}} ({{facture.montant}}, retard de {{facture.jours_retard}} jour(s)), l'accès de {{etablissement.nom}} à GHMT sera suspendu.${INVOICE_PAY_FR}`),
  t('subscription.suspension_notice', 'email', 'en', 'Suspension notice: invoice {{facture.numero}}', `Hello,\n\nWithout payment of invoice {{facture.numero}} ({{facture.montant}}, {{facture.jours_retard}} day(s) overdue), access to GHMT for {{etablissement.nom}} will be suspended.${INVOICE_PAY_EN}`),
];

const SUBSCRIPTION_INAPP: readonly DefaultTemplate[] = [
  t('subscription.invoice_issued', 'inapp', 'fr', 'Nouvelle facture {{facture.numero}}', 'Facture de {{facture.montant}}, échéance le {{facture.echeance}}.'),
  t('subscription.invoice_issued', 'inapp', 'en', 'New invoice {{facture.numero}}', 'Invoice for {{facture.montant}}, due on {{facture.echeance}}.'),
  t('subscription.payment_reminder', 'inapp', 'fr', 'Facture {{facture.numero}} bientôt due', 'Échéance le {{facture.echeance}} pour {{facture.montant}}.'),
  t('subscription.payment_reminder', 'inapp', 'en', 'Invoice {{facture.numero}} due soon', 'Due on {{facture.echeance}} for {{facture.montant}}.'),
  t('subscription.payment_overdue', 'inapp', 'fr', 'Facture {{facture.numero}} en retard', 'Retard de {{facture.jours_retard}} jour(s) pour {{facture.montant}}. Merci de régler.'),
  t('subscription.payment_overdue', 'inapp', 'en', 'Invoice {{facture.numero}} overdue', '{{facture.jours_retard}} day(s) overdue for {{facture.montant}}. Please pay.'),
  t('subscription.suspension_notice', 'inapp', 'fr', 'Suspension imminente', 'Sans règlement de la facture {{facture.numero}}, l’accès sera suspendu.'),
  t('subscription.suspension_notice', 'inapp', 'en', 'Suspension imminent', 'Without payment of invoice {{facture.numero}}, access will be suspended.'),
];

const QUOTA: readonly DefaultTemplate[] = [
  t('quota.sms_threshold', 'email', 'fr', 'Quota SMS atteint à {{quota.pourcentage}} %', `Bonjour,\n\n{{etablissement.nom}} a consommé {{quota.pourcentage}} % de son quota mensuel de SMS (limite : {{quota.limite}} segments). Au-delà, les SMS sont remplacés par des e-mails quand c'est possible.\n\nGérer l'abonnement : {{lien}}`),
  t('quota.sms_threshold', 'email', 'en', 'SMS quota reached at {{quota.pourcentage}}%', `Hello,\n\n{{etablissement.nom}} has used {{quota.pourcentage}}% of its monthly SMS quota (limit: {{quota.limite}} segments). Beyond it, SMS are replaced by e-mails when possible.\n\nManage the subscription: {{lien}}`),
  t('quota.sms_threshold', 'inapp', 'fr', 'Quota SMS à {{quota.pourcentage}} %', 'Limite mensuelle : {{quota.limite}} segments.'),
  t('quota.sms_threshold', 'inapp', 'en', 'SMS quota at {{quota.pourcentage}}%', 'Monthly limit: {{quota.limite}} segments.'),
];

export const DEFAULT_TEMPLATES: readonly DefaultTemplate[] = [...APPOINTMENT_SMS, ...APPOINTMENT_EMAIL, ...SUBSCRIPTION_EMAIL, ...SUBSCRIPTION_INAPP, ...QUOTA];

const FALLBACK_LOCALE: NotificationLocale = 'fr';

export function findDefaultTemplate(typeCode: string, channel: NotificationChannel, locale: NotificationLocale): DefaultTemplate | undefined {
  return DEFAULT_TEMPLATES.find((template) => template.typeCode === typeCode && template.channel === channel && template.locale === locale);
}

/** Modèle par défaut de la langue, à défaut en français (chaîne de repli de D11). */
export function resolveDefaultTemplate(typeCode: string, channel: NotificationChannel, locale: NotificationLocale): DefaultTemplate | undefined {
  return findDefaultTemplate(typeCode, channel, locale) ?? findDefaultTemplate(typeCode, channel, FALLBACK_LOCALE);
}
