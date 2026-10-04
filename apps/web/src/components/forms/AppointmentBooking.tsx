'use client';

import { useState } from 'react';
import { AppointmentForm, type AppointmentFormProps } from './AppointmentForm';
import { PatientSearch } from './PatientSearch';
import { buttonClass } from '@/components/ui/styles';

export interface BookingPatient {
  readonly id: string;
  readonly fullName: string;
}

export interface AppointmentBookingProps extends Omit<AppointmentFormProps, 'patientId' | 'patientName'> {
  readonly initialPatient?: BookingPatient | undefined;
}

/** Choix du patient (recherche POST, état client minimal) puis formulaire de rendez-vous. */
export function AppointmentBooking({ initialPatient, ...formProps }: AppointmentBookingProps) {
  const [patient, setPatient] = useState<BookingPatient | null>(initialPatient ?? null);
  if (!patient) return <PatientSearch onSelect={(p) => { setPatient({ id: p.id, fullName: p.fullName }); }} />;
  return (
    <>
      <AppointmentForm {...formProps} patientId={patient.id} patientName={patient.fullName} />
      <p className="mt-3">
        <button type="button" className={`${buttonClass.secondary} mt-1`} onClick={() => { setPatient(null); }}>Choisir un autre patient</button>
      </p>
    </>
  );
}
