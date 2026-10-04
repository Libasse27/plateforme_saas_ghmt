export interface AgendaParams {
  readonly date?: string | undefined;
  readonly practitionerId?: string | undefined;
  readonly patientId?: string | undefined;
  readonly ipp?: string | undefined;
  readonly nouveau?: boolean | undefined;
}

/** Construit une URL /rendez-vous en omettant les paramètres vides. */
export function agendaHref(params: AgendaParams): string {
  const search = new URLSearchParams();
  if (params.date) search.set('date', params.date);
  if (params.practitionerId) search.set('practitionerId', params.practitionerId);
  if (params.patientId) search.set('patientId', params.patientId);
  if (params.ipp) search.set('ipp', params.ipp);
  if (params.nouveau) search.set('nouveau', '1');
  const qs = search.toString();
  return qs ? `/rendez-vous?${qs}` : '/rendez-vous';
}
