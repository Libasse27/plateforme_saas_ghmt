import { describe, expect, it } from 'vitest';
import { appointmentVariables, formatAmount, formatLongDate, invoiceVariables, quotaVariables } from './message-variables';

describe('formatAmount', () => {
  it('groupe les milliers et retire les décimales nulles', () => {
    expect(formatAmount('25000.00', 'XOF', 'fr')).toBe('25 000 XOF');
    expect(formatAmount('1000000000.00', 'XOF', 'fr')).toBe('1 000 000 000 XOF');
    expect(formatAmount('999', 'XOF', 'fr')).toBe('999 XOF');
  });

  it('conserve les décimales significatives, avec le séparateur de la langue', () => {
    expect(formatAmount('1500.50', 'EUR', 'fr')).toBe('1 500,50 EUR');
    expect(formatAmount('1500.50', 'EUR', 'en')).toBe('1,500.50 EUR');
  });
});

describe('formatLongDate', () => {
  it('formate jour, mois et année dans le fuseau et la langue', () => {
    const instant = new Date('2026-10-20T23:30:00Z');

    expect(formatLongDate(instant, 'Africa/Dakar', 'fr')).toBe('20 octobre 2026');
    expect(formatLongDate(instant, 'Africa/Douala', 'fr')).toBe('21 octobre 2026');
    expect(formatLongDate(instant, 'Africa/Dakar', 'en')).toBe('20 October 2026');
  });
});

describe('appointmentVariables', () => {
  const facts = {
    tenantName: 'Clinique Awa',
    senderDisplayName: null,
    siteName: 'Site principal',
    patientFirstName: 'Fatou',
    startsAt: new Date('2026-10-07T14:30:00Z'),
    timeZone: 'Africa/Douala',
    locale: 'fr' as const,
  };

  it('formate la date et l’heure dans la langue et le fuseau du site', () => {
    expect(appointmentVariables(facts)).toEqual({
      'etablissement.nom': 'Clinique Awa',
      'site.nom': 'Site principal',
      'patient.prenom': 'Fatou',
      'rdv.date': 'mercredi 7 octobre',
      'rdv.heure': '15:30',
    });
  });

  it('remplace le nom de l’établissement par le nom d’expéditeur quand il est réglé', () => {
    expect(appointmentVariables({ ...facts, senderDisplayName: 'Clinique A.' })['etablissement.nom']).toBe('Clinique A.');
  });
});

describe('invoiceVariables', () => {
  const context = { invoiceNumber: 'GHMT-SN-2026-000123', amount: '25000.00', currency: 'XOF', dueAt: '2026-10-20T00:00:00.000Z', offsetDays: 3 };
  const facts = { tenantName: 'Clinique Awa', senderDisplayName: null, timeZone: 'Africa/Dakar', locale: 'fr' as const, now: new Date('2026-10-23T08:00:00Z'), link: 'https://app.example.com/abonnement' };

  it('expose numéro, montant, échéance, retard en jours et lien', () => {
    expect(invoiceVariables(context, facts)).toEqual({
      'etablissement.nom': 'Clinique Awa',
      'facture.numero': 'GHMT-SN-2026-000123',
      'facture.montant': '25 000 XOF',
      'facture.echeance': '20 octobre 2026',
      'facture.jours_retard': '3',
      lien: 'https://app.example.com/abonnement',
    });
  });
});

describe('quotaVariables', () => {
  it('expose le pourcentage, la limite et le lien', () => {
    const values = quotaVariables({ month: '2026-10', thresholdPercent: 80, limit: 200 }, { tenantName: 'Clinique Awa', senderDisplayName: null, link: 'https://app.example.com/abonnement' });

    expect(values).toEqual({ 'etablissement.nom': 'Clinique Awa', 'quota.pourcentage': '80', 'quota.limite': '200', lien: 'https://app.example.com/abonnement' });
  });
});
