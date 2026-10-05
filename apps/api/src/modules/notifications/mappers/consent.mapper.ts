import { CONSENT_CHANNELS, type ConsentChannel, type ConsentSource, type ContactConsentEntry, type ContactConsentsView } from '@ghmt/shared';
import type { PatientContactConsent } from '../../../generated/prisma/client';
import type { CurrentConsents } from '../repositories/consents.repository';

const PURPOSE = 'appointment_reminder' as const;

function toEntry(row: PatientContactConsent): ContactConsentEntry {
  return {
    id: row.id,
    channel: row.channel as ConsentChannel,
    purpose: PURPOSE,
    granted: row.granted,
    source: row.source as ConsentSource,
    recordedAt: row.recordedAt.toISOString(),
  };
}

/** État courant par canal (`granted:false` si jamais recueilli) et 50 dernières entrées de l'historique. */
export function toConsentsView(patientId: string, current: CurrentConsents, history: readonly PatientContactConsent[]): ContactConsentsView {
  return {
    patientId,
    current: CONSENT_CHANNELS.map((channel) => {
      const row = current[channel];
      return { channel, purpose: PURPOSE, granted: row?.granted ?? false, source: (row?.source as ConsentSource | undefined) ?? null, recordedAt: row?.recordedAt.toISOString() ?? null };
    }),
    history: history.map(toEntry),
  };
}
