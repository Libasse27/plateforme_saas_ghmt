import { isUuid } from './raw';

export interface NewInvoiceLink {
  readonly patientId?: string | undefined;
  readonly appointmentId?: string | undefined;
}

/**
 * Lien « Facturer » : seuls des identifiants (UUID) figurent dans l'URL, jamais de nom, de téléphone
 * ni de donnée de santé ; tout identifiant mal formé est ignoré.
 */
export function newInvoiceHref(link: NewInvoiceLink): string {
  const search = new URLSearchParams();
  if (isUuid(link.patientId)) search.set('patientId', link.patientId);
  if (isUuid(link.appointmentId)) search.set('appointmentId', link.appointmentId);
  const qs = search.toString();
  return qs ? `/facturation/factures/nouvelle?${qs}` : '/facturation/factures/nouvelle';
}
