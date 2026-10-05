import type { AuditService } from '../../../common/audit/audit.service';
import type { TenantTx } from '../../../infrastructure/prisma/tenant-db.service';

const PURPOSE = 'appointment_reminder';

/**
 * Un nouveau numéro n'hérite pas du consentement SMS de l'ancien (il peut appartenir à un tiers) : si le consentement SMS
 * courant est accordé, il est révoqué (source `phone_change`, auteur = l'utilisateur), les rappels SMS en attente sont
 * supprimés et le changement est audité. Sans consentement accordé, rien n'est écrit.
 */
export async function resetSmsConsentOnPhoneChange(
  tx: TenantTx,
  audit: AuditService,
  input: { tenantId: string; patientId: string; actorId: string; now: Date },
): Promise<void> {
  const { tenantId, patientId, actorId, now } = input;
  const latest = await tx.patientContactConsent.findFirst({
    where: { tenantId, patientId, channel: 'sms', purpose: PURPOSE },
    orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
  });
  if (!latest?.granted) return;
  await tx.patientContactConsent.create({ data: { tenantId, patientId, channel: 'sms', purpose: PURPOSE, granted: false, source: 'phone_change', recordedBy: actorId } });
  await tx.notification.updateMany({
    where: { tenantId, recipientType: 'patient', recipientId: patientId, category: 'clinical_reminder', channel: 'sms', status: 'queued' },
    data: { status: 'suppressed', suppressionReason: 'no_consent', suppressedAt: now, lockedUntil: null, updatedAt: now },
  });
  await audit.record(tx, tenantId, {
    action: 'patient.consent_changed',
    resourceType: 'patient',
    resourceId: patientId,
    patientId,
    changes: { channel: 'sms', purpose: PURPOSE, granted: false, source: 'phone_change' },
  });
}
