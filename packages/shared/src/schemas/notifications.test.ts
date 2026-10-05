import { describe, expect, it } from 'vitest';
import {
  NOTIFICATION_TYPES,
  NOTIFICATION_TYPE_CODES,
  SUPPRESSION_REASONS,
  listDeliveriesQuerySchema,
  listInboxQuerySchema,
  listNotificationTemplatesQuerySchema,
  previewNotificationTemplateSchema,
  recordContactConsentSchema,
  smsDeliveryWebhookSchema,
  smsInboundWebhookSchema,
  updateNotificationPreferencesSchema,
  updateNotificationSettingsSchema,
  upsertNotificationTemplateSchema,
} from './index';

const UUID = '0197a3c0-0000-7000-8000-000000000001';

describe('catalogue des types de notification', () => {
  it('expose les 10 types figés avec leurs variables autorisées', () => {
    expect(NOTIFICATION_TYPE_CODES).toHaveLength(10);
    expect(NOTIFICATION_TYPES['appointment.reminder_h2']).toMatchObject({ category: 'clinical_reminder', recipient: 'patient' });
    expect(NOTIFICATION_TYPES['appointment.confirmed'].variables).toEqual(['etablissement.nom', 'site.nom', 'patient.prenom', 'rdv.date', 'rdv.heure']);
    expect(NOTIFICATION_TYPES['subscription.payment_overdue'].channels).toEqual(['email', 'inapp']);
    expect(NOTIFICATION_TYPES['quota.sms_threshold'].variables).toContain('quota.pourcentage');
  });

  it('liste les 11 motifs de suppression du contrat', () => {
    expect(SUPPRESSION_REASONS).toHaveLength(11);
    expect(SUPPRESSION_REASONS).toContain('invoice_settled');
  });
});

describe('listInboxQuerySchema', () => {
  it('applique la limite par défaut de 20 et borne 1..50', () => {
    expect(listInboxQuerySchema.parse({}).limit).toBe(20);
    expect(listInboxQuerySchema.safeParse({ limit: '51' }).success).toBe(false);
    expect(listInboxQuerySchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(listInboxQuerySchema.parse({ limit: '50', unreadOnly: 'true' })).toMatchObject({ limit: 50, unreadOnly: 'true' });
  });

  it('refuse une valeur unreadOnly inconnue', () => {
    expect(listInboxQuerySchema.safeParse({ unreadOnly: 'oui' }).success).toBe(false);
  });
});

describe('updateNotificationPreferencesSchema', () => {
  it('exige entre 1 et 10 éléments valides', () => {
    expect(updateNotificationPreferencesSchema.safeParse({ items: [] }).success).toBe(false);
    expect(updateNotificationPreferencesSchema.safeParse({ items: [{ category: 'administrative', channel: 'email', enabled: false }] }).success).toBe(true);
    expect(updateNotificationPreferencesSchema.safeParse({ items: [{ category: 'transactional', channel: 'email', enabled: false }] }).success).toBe(false);
    expect(updateNotificationPreferencesSchema.safeParse({ items: [{ category: 'administrative', channel: 'sms', enabled: false }] }).success).toBe(false);
    const eleven = Array.from({ length: 11 }, () => ({ category: 'administrative', channel: 'email', enabled: true }));
    expect(updateNotificationPreferencesSchema.safeParse({ items: eleven }).success).toBe(false);
  });
});

describe('updateNotificationSettingsSchema', () => {
  it('exige au moins un champ', () => {
    expect(updateNotificationSettingsSchema.safeParse({}).success).toBe(false);
    expect(updateNotificationSettingsSchema.safeParse({ smsTransliterate: false }).success).toBe(true);
  });

  it('valide le format HH:MM des heures', () => {
    expect(updateNotificationSettingsSchema.safeParse({ quietHoursStart: '21:00', quietHoursEnd: '07:30' }).success).toBe(true);
    expect(updateNotificationSettingsSchema.safeParse({ quietHoursStart: '24:00' }).success).toBe(false);
    expect(updateNotificationSettingsSchema.safeParse({ reminderD1LocalTime: '9:00' }).success).toBe(false);
    expect(updateNotificationSettingsSchema.safeParse({ reminderD1LocalTime: '10:60' }).success).toBe(false);
  });

  it('accepte un nom d’expéditeur de 2 à 30 caractères ou null', () => {
    expect(updateNotificationSettingsSchema.safeParse({ senderDisplayName: 'A' }).success).toBe(false);
    expect(updateNotificationSettingsSchema.safeParse({ senderDisplayName: 'x'.repeat(31) }).success).toBe(false);
    expect(updateNotificationSettingsSchema.safeParse({ senderDisplayName: 'Clinique Awa' }).success).toBe(true);
    expect(updateNotificationSettingsSchema.safeParse({ senderDisplayName: null }).success).toBe(true);
  });
});

describe('modèles', () => {
  it('upsert : corps de 1 à 5000 caractères, sujet de 150 au plus', () => {
    expect(upsertNotificationTemplateSchema.safeParse({ body: '' }).success).toBe(false);
    expect(upsertNotificationTemplateSchema.safeParse({ body: 'x'.repeat(5001) }).success).toBe(false);
    expect(upsertNotificationTemplateSchema.safeParse({ body: 'ok', subject: 'x'.repeat(151) }).success).toBe(false);
    expect(upsertNotificationTemplateSchema.safeParse({ body: 'ok', subject: 'Sujet' }).success).toBe(true);
  });

  it('liste : filtre optionnel par type du catalogue', () => {
    expect(listNotificationTemplatesQuerySchema.safeParse({}).success).toBe(true);
    expect(listNotificationTemplatesQuerySchema.safeParse({ typeCode: 'appointment.confirmed' }).success).toBe(true);
    expect(listNotificationTemplatesQuerySchema.safeParse({ typeCode: 'inconnu' }).success).toBe(false);
  });

  it('aperçu : type, canal et langue du catalogue', () => {
    const valid = { typeCode: 'appointment.confirmed', channel: 'sms', locale: 'fr', body: 'Bonjour' };
    expect(previewNotificationTemplateSchema.safeParse(valid).success).toBe(true);
    expect(previewNotificationTemplateSchema.safeParse({ ...valid, typeCode: 'inconnu' }).success).toBe(false);
    expect(previewNotificationTemplateSchema.safeParse({ ...valid, locale: 'es' }).success).toBe(false);
    expect(previewNotificationTemplateSchema.safeParse({ ...valid, channel: 'push' }).success).toBe(false);
  });
});

describe('listDeliveriesQuerySchema', () => {
  it('limite 1..100 (50 par défaut) et filtres énumérés', () => {
    expect(listDeliveriesQuerySchema.parse({}).limit).toBe(50);
    expect(listDeliveriesQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
    expect(listDeliveriesQuerySchema.safeParse({ status: 'perdu' }).success).toBe(false);
    expect(listDeliveriesQuerySchema.safeParse({ status: 'sent', channel: 'sms', typeCode: 'appointment.confirmed' }).success).toBe(true);
  });

  it('refuse une période inversée', () => {
    expect(listDeliveriesQuerySchema.safeParse({ from: '2026-10-05T00:00:00Z', to: '2026-10-04T00:00:00Z' }).success).toBe(false);
    expect(listDeliveriesQuerySchema.safeParse({ from: '2026-10-04T00:00:00Z', to: '2026-10-05T00:00:00Z' }).success).toBe(true);
  });
});

describe('recordContactConsentSchema', () => {
  const valid = { channel: 'sms', purpose: 'appointment_reminder', granted: true, source: 'front_desk' };

  it('accepte une saisie au guichet ou à la demande du patient', () => {
    expect(recordContactConsentSchema.safeParse(valid).success).toBe(true);
    expect(recordContactConsentSchema.safeParse({ ...valid, source: 'patient_request' }).success).toBe(true);
  });

  it('refuse la source sms_stop, réservée au traitement du STOP', () => {
    expect(recordContactConsentSchema.safeParse({ ...valid, source: 'sms_stop' }).success).toBe(false);
  });

  it('refuse la source phone_change, réservée au changement de numéro', () => {
    expect(recordContactConsentSchema.safeParse({ ...valid, source: 'phone_change' }).success).toBe(false);
  });

  it('refuse une finalité ou un canal inconnu', () => {
    expect(recordContactConsentSchema.safeParse({ ...valid, purpose: 'marketing' }).success).toBe(false);
    expect(recordContactConsentSchema.safeParse({ ...valid, channel: 'inapp' }).success).toBe(false);
  });
});

describe('webhooks SMS', () => {
  it('accusé de réception : clientRef <tenant>.<notification> et statut énuméré', () => {
    const ref = `${UUID}.${UUID}`;
    expect(smsDeliveryWebhookSchema.safeParse({ clientRef: ref, status: 'delivered' }).success).toBe(true);
    expect(smsDeliveryWebhookSchema.safeParse({ clientRef: ref, status: 'undeliverable', errorCode: 'x'.repeat(50) }).success).toBe(true);
    expect(smsDeliveryWebhookSchema.safeParse({ clientRef: ref, status: 'delivered', errorCode: 'x'.repeat(51) }).success).toBe(false);
    expect(smsDeliveryWebhookSchema.safeParse({ clientRef: 'abc', status: 'delivered' }).success).toBe(false);
    expect(smsDeliveryWebhookSchema.safeParse({ clientRef: ref, status: 'pending' }).success).toBe(false);
  });

  it('message entrant : numéro E.164 et texte de 1600 caractères au plus', () => {
    expect(smsInboundWebhookSchema.safeParse({ from: '+221771234567', text: 'STOP' }).success).toBe(true);
    expect(smsInboundWebhookSchema.safeParse({ from: '771234567', text: 'STOP' }).success).toBe(false);
    expect(smsInboundWebhookSchema.safeParse({ from: '+221771234567', text: 'x'.repeat(1601) }).success).toBe(false);
  });
});
