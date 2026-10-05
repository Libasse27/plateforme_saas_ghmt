import { GENESIS_HASH, verifyChain, type ChainedRecord } from '../../../common/audit/audit-chain';
import { auditPayload } from '../../../common/audit/audit.service';

/** Maillon relu en base : colonnes de la charge utile hachée, plus les empreintes. */
export interface AuditChainRow {
  readonly tenantId: string;
  readonly chainSeq: bigint;
  readonly occurredAt: Date;
  readonly actorType: string;
  readonly actorUserId: string | null;
  readonly sessionId: string | null;
  readonly ip: string | null;
  readonly action: string;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly patientId: string | null;
  readonly outcome: string;
  readonly changes: unknown;
  readonly requestId: string | null;
  readonly prevHash: Uint8Array;
  readonly hash: Uint8Array;
}

function toRecord(row: AuditChainRow): ChainedRecord {
  return { chainSeq: row.chainSeq, prevHash: row.prevHash, hash: row.hash, payload: auditPayload({ ...row, changes: row.changes ?? null }) };
}

function startsAtGenesis(first: AuditChainRow): boolean {
  return first.chainSeq !== 1n || Buffer.from(first.prevHash).equals(GENESIS_HASH);
}

/**
 * Plus petit `chain_seq` rompu dans une fenêtre triée par ordre croissant, ou `null` si elle est intacte.
 * Chemin rapide : `verifyChain` sur la fenêtre entière ; la recherche maillon par maillon n'a lieu qu'en cas de rupture.
 * Une rupture de lien est attribuée au maillon qui pointe vers un prédécesseur inattendu.
 */
export function findFirstBrokenSeq(rows: readonly AuditChainRow[]): bigint | null {
  const first = rows[0];
  if (!first) return null;
  const records = rows.map(toRecord);
  if (!startsAtGenesis(first)) return first.chainSeq;
  if (verifyChain(records)) return null;
  const broken = records.findIndex((record, i) => !verifyChain(i === 0 ? [record] : [records[i - 1]!, record]));
  return broken === -1 ? first.chainSeq : records[broken]!.chainSeq;
}
