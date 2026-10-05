import { localDateKey } from '../../../common/time/local-date';

const SEQUENCE_DIGITS = 6;
export const INVOICE_SEQUENCE_SCOPE = 'invoice';

/** Année civile locale de l'établissement : la numérotation repart à 1 chaque année locale. */
export function invoiceYearOf(at: Date, timeZone: string): number {
  return Number(localDateKey(at, timeZone).slice(0, 4));
}

export function formatInvoiceNumber(year: number, sequence: bigint): string {
  return `FAC-${year}-${sequence.toString().padStart(SEQUENCE_DIGITS, '0')}`;
}
