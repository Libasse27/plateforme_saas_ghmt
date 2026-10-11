import { describe, expect, it } from 'vitest';
import type { PermissionKey } from '@ghmt/shared';
import type { EffectiveGrant } from './authorization.types';
import { clinicalMfaRequired, hasClinicalGrant, mfaRequiredFor } from './clinical-mfa';

const grant = (permission: string, mfaRequired = false): EffectiveGrant => ({
  permission: permission as PermissionKey,
  scopeType: 'tenant',
  scopeId: null,
  mfaRequired,
});

const doctor = [grant('consultations:consultation:read'), grant('patients:patient:read')];
const receptionist = [grant('patients:patient:read'), grant('appointments:appointment:create')];

describe('hasClinicalGrant', () => {
  it('détecte une permission des modules cliniques, quel que soit le nom du rôle', () => {
    expect(hasClinicalGrant(doctor)).toBe(true);
    expect(hasClinicalGrant([grant('laboratory:order:read')])).toBe(true);
    expect(hasClinicalGrant([grant('imaging:study:read')])).toBe(true);
    expect(hasClinicalGrant([grant('inpatient:admission:read')])).toBe(true);
  });

  it('ne tient pas patients:patient:read seul pour clinique', () => {
    expect(hasClinicalGrant(receptionist)).toBe(false);
    expect(hasClinicalGrant([])).toBe(false);
    expect(hasClinicalGrant([grant('cashier:payment:create'), grant('accounting:entry:read')])).toBe(false);
  });
});

describe('clinicalMfaRequired', () => {
  it('exige la MFA hors réseau de confiance en mode off_network', () => {
    expect(clinicalMfaRequired({ grants: doctor, mode: 'off_network', networkTrusted: false })).toBe(true);
    expect(clinicalMfaRequired({ grants: doctor, mode: 'off_network', networkTrusted: true })).toBe(false);
  });

  it('exige la MFA partout en mode always, réseau de confiance compris', () => {
    expect(clinicalMfaRequired({ grants: doctor, mode: 'always', networkTrusted: true })).toBe(true);
  });

  it('ne concerne jamais un utilisateur non clinique', () => {
    expect(clinicalMfaRequired({ grants: receptionist, mode: 'always', networkTrusted: false })).toBe(false);
  });
});

describe('mfaRequiredFor', () => {
  it('conserve l’exigence des rôles mfaRequired partout', () => {
    const admin = [grant('iam:user:read', true)];
    expect(mfaRequiredFor({ grants: admin, mode: 'off_network', networkTrusted: true })).toBe(true);
  });

  it('combine l’exigence du rôle et la règle clinique', () => {
    expect(mfaRequiredFor({ grants: doctor, mode: 'off_network', networkTrusted: false })).toBe(true);
    expect(mfaRequiredFor({ grants: doctor, mode: 'off_network', networkTrusted: true })).toBe(false);
    expect(mfaRequiredFor({ grants: receptionist, mode: 'always', networkTrusted: false })).toBe(false);
  });

  it('aucune plage déclarée : tout réseau est hors confiance, donc la MFA est exigée des soignants', () => {
    expect(mfaRequiredFor({ grants: doctor, mode: 'off_network', networkTrusted: false })).toBe(true);
  });
});

describe('permissions de stock pharmacie (décision 22)', () => {
  it('ne rendent pas un rôle clinique : gestionnaire de stock', () => {
    const storekeeper = [grant('pharmacy:drug:read'), grant('pharmacy:stock_movement:read'), grant('pharmacy:stock_movement:create')];
    expect(hasClinicalGrant(storekeeper)).toBe(false);
    expect(clinicalMfaRequired({ grants: storekeeper, mode: 'always', networkTrusted: false })).toBe(false);
  });

  it('la dispensation reste clinique, même avec les permissions de stock', () => {
    expect(hasClinicalGrant([grant('pharmacy:drug:read'), grant('pharmacy:dispensation:create')])).toBe(true);
  });

  it('l’agent administratif des admissions est clinique', () => {
    expect(hasClinicalGrant([grant('patients:patient:read'), grant('inpatient:admission:create')])).toBe(true);
  });
});
