import { describe, expect, it } from 'vitest';
import { allowedStatusActions, remapSlotErrors } from './appointments';

describe('allowedStatusActions', () => {
  it('propose confirmer / arrivé / annuler selon le statut', () => {
    expect(allowedStatusActions('scheduled').map((a) => a.action)).toEqual(['confirm', 'check_in', 'cancel']);
    expect(allowedStatusActions('confirmed').map((a) => a.action)).toEqual(['check_in', 'cancel']);
    expect(allowedStatusActions('checked_in').map((a) => a.action)).toEqual(['cancel']);
  });
  it('ne gère plus le statut « requested » ni les statuts terminaux', () => {
    expect(allowedStatusActions('requested')).toEqual([]);
    expect(allowedStatusActions('cancelled')).toEqual([]);
  });
  it('défaut fermé : statut inconnu ⇒ aucune action', () => {
    expect(allowedStatusActions('unknown')).toEqual([]);
  });
});

describe('remapSlotErrors', () => {
  it('rabat startsAt / endsAt sur le champ « time »', () => {
    expect(remapSlotErrors({ startsAt: 'Créneau passé.', endsAt: 'x', reason: 'Trop long.' })).toEqual({ time: 'Créneau passé.', reason: 'Trop long.' });
    expect(remapSlotErrors({ endsAt: 'Fin invalide.' })).toEqual({ time: 'Fin invalide.' });
  });
  it('ne modifie pas des erreurs sans créneau', () => {
    expect(remapSlotErrors({ siteId: 'Requis.' })).toEqual({ siteId: 'Requis.' });
  });
});
