export type AuditOutcome = 'success' | 'denied' | 'failure';
export type AuditActorType = 'user' | 'system' | 'anonymous';

/** Événement d'audit (docs/04 §7). Ne jamais y mettre de donnée clinique en clair. */
export interface AuditEvent {
  readonly action: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly patientId?: string;
  /** Patients concernés par une lecture groupée (recherche, liste) ; consignés dans `changes.patientIds`. */
  readonly patientIds?: readonly string[];
  readonly outcome?: AuditOutcome;
  readonly changes?: Readonly<Record<string, unknown>>;
  /** Par défaut : le principal courant. */
  readonly actorUserId?: string;
  readonly actorType?: AuditActorType;
}
