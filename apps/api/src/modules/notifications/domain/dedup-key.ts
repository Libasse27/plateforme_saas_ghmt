import { createHash } from 'node:crypto';
import type { NotificationChannel } from '@ghmt/shared';

export interface DedupKeyInput {
  readonly tenantId: string;
  /** Identifiant de l'origine : événement outbox, rendez-vous, facture SaaS ou `quota:<AAAA-MM>` (docs/10 D3). */
  readonly sourceKey: string;
  readonly typeCode: string;
  readonly recipientType: 'user' | 'patient';
  readonly recipientId: string;
  readonly channel: NotificationChannel;
  /** `startsAt` ISO d'un rappel, décalage en jours d'une relance, seuil d'une alerte de quota, `*_fallback`… */
  readonly variant?: string;
}

/**
 * Clé de déduplication : SHA-256 hexadécimal des champs de D3. Les champs sont sérialisés en JSON (tableau) pour qu'aucun
 * séparateur présent dans une valeur ne puisse faire coïncider deux découpages différents.
 */
export function dedupKey(input: DedupKeyInput): string {
  const fields = [input.tenantId, input.sourceKey, input.typeCode, `${input.recipientType}:${input.recipientId}`, input.channel, input.variant ?? ''];
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}
