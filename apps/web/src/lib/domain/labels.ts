import type { EstablishmentType } from '@ghmt/shared';
import type { DisplayStatus } from './appointments';

export const ESTABLISHMENT_TYPE_LABELS: Readonly<Record<EstablishmentType, string>> = {
  hospital_n1: 'Hôpital de niveau 1 (référence nationale)',
  hospital_n2: 'Hôpital de niveau 2 (régional)',
  hospital_n3: 'Hôpital de niveau 3 (district)',
  medicalized_center: 'Centre médicalisé',
  health_center: 'Centre de santé',
  clinic: 'Clinique',
  private_practice: 'Cabinet médical',
  laboratory: 'Laboratoire',
  pharmacy: 'Pharmacie',
  diagnostic_center: 'Centre de diagnostic',
  specialized_center: 'Centre spécialisé',
  other: 'Autre',
};

export const APPOINTMENT_STATUS_LABELS: Readonly<Record<DisplayStatus, string>> = {
  requested: 'Demandé',
  scheduled: 'Planifié',
  confirmed: 'Confirmé',
  checked_in: 'Arrivé',
  in_progress: 'En consultation',
  completed: 'Terminé',
  cancelled: 'Annulé',
  no_show: 'Absent',
  unknown: 'Statut inconnu',
};

export const SEX_LABELS: Readonly<Record<string, string>> = {
  male: 'Masculin',
  female: 'Féminin',
  other: 'Autre',
  unknown: 'Non précisé',
};

export interface CountryPreset {
  readonly code: string;
  readonly name: string;
  readonly currency: 'XOF' | 'XAF' | 'CDF' | 'USD' | 'EUR';
  readonly timezone: string;
}

/** Pays cibles (docs/00) avec devise et fuseau par défaut. */
export const COUNTRY_PRESETS: readonly CountryPreset[] = [
  { code: 'SN', name: 'Sénégal', currency: 'XOF', timezone: 'Africa/Dakar' },
  { code: 'CI', name: 'Côte d\'Ivoire', currency: 'XOF', timezone: 'Africa/Abidjan' },
  { code: 'CM', name: 'Cameroun', currency: 'XAF', timezone: 'Africa/Douala' },
  { code: 'CD', name: 'RD Congo', currency: 'CDF', timezone: 'Africa/Kinshasa' },
  { code: 'BJ', name: 'Bénin', currency: 'XOF', timezone: 'Africa/Porto-Novo' },
  { code: 'TG', name: 'Togo', currency: 'XOF', timezone: 'Africa/Lome' },
  { code: 'BF', name: 'Burkina Faso', currency: 'XOF', timezone: 'Africa/Ouagadougou' },
  { code: 'ML', name: 'Mali', currency: 'XOF', timezone: 'Africa/Bamako' },
  { code: 'GA', name: 'Gabon', currency: 'XAF', timezone: 'Africa/Libreville' },
  { code: 'CG', name: 'Congo', currency: 'XAF', timezone: 'Africa/Brazzaville' },
  { code: 'NE', name: 'Niger', currency: 'XOF', timezone: 'Africa/Niamey' },
  { code: 'GN', name: 'Guinée', currency: 'USD', timezone: 'Africa/Conakry' },
];

export const CURRENCY_LABELS: Readonly<Record<string, string>> = {
  XOF: 'Franc CFA (UEMOA) - XOF',
  XAF: 'Franc CFA (CEMAC) - XAF',
  CDF: 'Franc congolais - CDF',
  USD: 'Dollar US - USD',
  EUR: 'Euro - EUR',
};

export function presetFor(countryCode: string): CountryPreset | undefined {
  return COUNTRY_PRESETS.find((c) => c.code === countryCode);
}
