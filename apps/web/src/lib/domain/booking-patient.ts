import { toList, toPatient } from './mappers';

export interface BookingPatient {
  readonly id: string;
  readonly fullName: string;
}

const IPP = /^P\d{2}-\d{7}$/;
const SEARCH_LIMIT = 20;
const NEUTRAL_LABEL = 'Patient sélectionné';

export const isIpp = (value: string | undefined): value is string => value !== undefined && IPP.test(value);

/**
 * Nom du patient pour la prise de rendez-vous, SANS lire la fiche complète déchiffrée : recherche
 * minimale par IPP (POST /patients/search, identité seule) ; sans IPP, libellé neutre et aucune requête.
 */
export async function loadBookingPatient(
  search: (body: { readonly ipp: string; readonly limit: number }) => Promise<unknown>,
  patientId: string,
  ipp: string | undefined,
): Promise<BookingPatient> {
  if (!isIpp(ipp)) return { id: patientId, fullName: NEUTRAL_LABEL };
  const found = toList(await search({ ipp, limit: SEARCH_LIMIT }), toPatient).find((p) => p.id === patientId);
  return { id: patientId, fullName: found ? found.fullName : `${NEUTRAL_LABEL} (${ipp})` };
}
