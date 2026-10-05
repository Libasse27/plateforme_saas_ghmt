import { Injectable } from '@nestjs/common';
import { CONSENT_CHANNELS, type ConsentChannel, type ConsentSource } from '@ghmt/shared';
import type { PatientContactConsent } from '../../../generated/prisma/client';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';
import { CONSENT_HISTORY_LIMIT } from '../notifications.constants';

const PURPOSE = 'appointment_reminder';

export type CurrentConsents = Readonly<Record<ConsentChannel, PatientContactConsent | null>>;

@Injectable()
export class ConsentsRepository {
  /** Dernier enregistrement (accordé ou non) par canal : c'est le consentement courant. */
  async latestByChannel(tx: TenantTx, tenantId: string, patientId: string): Promise<CurrentConsents> {
    // Séquentiel : une transaction interactive n'exécute qu'une requête à la fois sur sa connexion.
    const entries: (readonly [ConsentChannel, PatientContactConsent | null])[] = [];
    for (const channel of CONSENT_CHANNELS) {
      const latest = await tx.patientContactConsent.findFirst({
        where: { tenantId, patientId, channel, purpose: PURPOSE },
        orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
      });
      entries.push([channel, latest]);
    }
    return Object.fromEntries(entries) as CurrentConsents;
  }

  history(tx: TenantTx, tenantId: string, patientId: string): Promise<PatientContactConsent[]> {
    return tx.patientContactConsent.findMany({
      where: { tenantId, patientId },
      orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
      take: CONSENT_HISTORY_LIMIT,
    });
  }

  record(
    tx: TenantTx,
    tenantId: string,
    entry: { patientId: string; channel: ConsentChannel; granted: boolean; source: ConsentSource; recordedBy: string | null },
  ): Promise<PatientContactConsent> {
    return tx.patientContactConsent.create({ data: { tenantId, ...entry, purpose: PURPOSE } });
  }
}
