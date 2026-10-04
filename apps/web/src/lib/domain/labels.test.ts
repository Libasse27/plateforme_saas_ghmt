import { describe, expect, it } from 'vitest';
import { APPOINTMENT_STATUSES, CURRENCIES, ESTABLISHMENT_TYPES } from '@ghmt/shared';
import { allowedStatusActions, isAppointmentStatus } from './appointments';
import { APPOINTMENT_STATUS_LABELS, COUNTRY_PRESETS, CURRENCY_LABELS, ESTABLISHMENT_TYPE_LABELS, presetFor } from './labels';

describe('libellés français', () => {
  it('couvre tous les types d\'établissement et statuts partagés', () => {
    for (const type of ESTABLISHMENT_TYPES) expect(ESTABLISHMENT_TYPE_LABELS[type]).toBeTruthy();
    for (const status of APPOINTMENT_STATUSES) expect(APPOINTMENT_STATUS_LABELS[status]).toBeTruthy();
    for (const currency of CURRENCIES) expect(CURRENCY_LABELS[currency]).toBeTruthy();
  });
  it('libellé du statut inconnu', () => {
    expect(APPOINTMENT_STATUS_LABELS.unknown).toBe('Statut inconnu');
  });
  it('les pays prédéfinis ont une devise connue', () => {
    for (const country of COUNTRY_PRESETS) expect(CURRENCIES).toContain(country.currency);
    expect(presetFor('CM')?.currency).toBe('XAF');
    expect(presetFor('ZZ')).toBeUndefined();
  });
});

describe('actions de statut', () => {
  it('propose confirmer / arrivé / annuler selon le statut', () => {
    expect(allowedStatusActions('scheduled').map((a) => a.status)).toEqual(['confirmed', 'checked_in', 'cancelled']);
    expect(allowedStatusActions('confirmed').map((a) => a.status)).toEqual(['checked_in', 'cancelled']);
    expect(allowedStatusActions('checked_in').map((a) => a.label)).toEqual(['Annuler']);
  });
  it('ne propose rien pour les statuts terminaux', () => {
    expect(allowedStatusActions('completed')).toEqual([]);
    expect(allowedStatusActions('cancelled')).toEqual([]);
  });
  it('isAppointmentStatus', () => {
    expect(isAppointmentStatus('confirmed')).toBe(true);
    expect(isAppointmentStatus('x')).toBe(false);
    expect(isAppointmentStatus(3)).toBe(false);
  });
});
