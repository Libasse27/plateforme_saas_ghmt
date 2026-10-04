import { describe, expect, it } from 'vitest';
import { newInvoiceHref } from './billing-links';

const PATIENT = '3f2b8c1e-1a2b-4c3d-8e9f-0123456789ab';
const APPT = '4a2b8c1e-1a2b-4c3d-8e9f-0123456789ab';

describe('newInvoiceHref', () => {
  it('ne contient que des identifiants UUID', () => {
    expect(newInvoiceHref({ patientId: PATIENT, appointmentId: APPT })).toBe(`/facturation/factures/nouvelle?patientId=${PATIENT}&appointmentId=${APPT}`);
    expect(newInvoiceHref({ patientId: PATIENT })).toBe(`/facturation/factures/nouvelle?patientId=${PATIENT}`);
  });
  it('ignore tout ce qui n\'est pas un UUID (nom, téléphone, IPP)', () => {
    expect(newInvoiceHref({ patientId: 'Awa Diallo', appointmentId: '+221771234567' })).toBe('/facturation/factures/nouvelle');
    expect(newInvoiceHref({})).toBe('/facturation/factures/nouvelle');
  });
});
