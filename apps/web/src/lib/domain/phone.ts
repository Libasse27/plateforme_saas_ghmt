import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js/min';

export type PhoneResult = { readonly ok: true; readonly e164: string } | { readonly ok: false; readonly error: string };

const PHONE_CHARS = /^\+?[\d\s().-]+$/;
const INVALID = 'Numéro de téléphone invalide. Vérifiez le nombre de chiffres ou saisissez le format international (+indicatif…).';
const UNKNOWN_COUNTRY = 'Pays de l\'établissement inconnu : saisissez le numéro au format international (+221…).';

const invalid = (error: string): PhoneResult => ({ ok: false, error });

/**
 * Normalise en E.164 avec libphonenumber-js. Un numéro international (« + » ou « 00 ») doit être
 * valide dans son pays ; un numéro local est interprété avec le pays du tenant (C4 `countryCode`) et
 * doit être valide pour ce pays (un indicatif déjà présent est reconnu). Jamais de E.164 inventé.
 */
export function normalizePhone(raw: string, countryCode: string | undefined): PhoneResult {
  const term = raw.trim();
  if (!PHONE_CHARS.test(term)) return invalid(INVALID);

  const international = term.startsWith('+') || term.startsWith('00');
  if (international) {
    const parsed = parsePhoneNumberFromString(term.startsWith('00') ? `+${term.slice(2)}` : term);
    return parsed?.isValid() ? { ok: true, e164: parsed.number } : invalid(INVALID);
  }

  const region = countryCode?.toUpperCase() as CountryCode | undefined;
  if (!region) return invalid(UNKNOWN_COUNTRY);
  const parsed = parsePhoneNumberFromString(term, region);
  if (parsed === undefined && !/^[A-Z]{2}$/.test(region)) return invalid(UNKNOWN_COUNTRY);
  return parsed?.isValid() && parsed.country === region ? { ok: true, e164: parsed.number } : invalid(INVALID);
}
