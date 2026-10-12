// Vérification de la chaîne d'audit d'un tenant (docs/13 D10), sans dépendre du code de l'API.
// MÊME algorithme que apps/api/src/common/audit/audit-chain.ts et auditPayload (audit.service.ts) : JSON canonique
// (clés triées), SHA-256(prev_hash || JSON). Cohérence garantie par les vecteurs de test/audit-chain.test.mjs.
import { createHash } from 'node:crypto';

const GENESIS_HASH = Buffer.alloc(32);

/** JSON canonique (clés triées, récursif), identique à celui de l'API. */
export function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Charge utile hachée, à partir d'une ligne `tenant.audit_logs` lue par `pg` (colonnes en snake_case). */
function payloadOf(row) {
  return {
    tenantId: row.tenant_id,
    chainSeq: String(row.chain_seq),
    occurredAt: row.occurred_at.toISOString(),
    actorType: row.actor_type,
    actorUserId: row.actor_user_id,
    sessionId: row.session_id,
    ip: row.ip,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    patientId: row.patient_id,
    outcome: row.outcome,
    changes: row.changes ?? null,
    requestId: row.request_id,
  };
}

function chainHash(prevHash, row) {
  return createHash('sha256').update(prevHash).update(canonicalJson(payloadOf(row))).digest();
}

/**
 * Vérificateur incrémental d'une chaîne COMPLÈTE, alimenté maillon par maillon dans l'ordre de `chain_seq` (lecture par
 * lots) : la chaîne commence à 1 sur l'empreinte d'origine, chaque maillon suit le précédent et son empreinte est
 * recalculée. `push` renvoie le `chain_seq` (texte) du maillon rompu, ou `null`.
 */
export function createChainVerifier() {
  let previous = null;
  return {
    push(row) {
      const seq = BigInt(row.chain_seq);
      const expectedSeq = previous ? previous.seq + 1n : 1n;
      const expectedPrev = previous ? previous.hash : GENESIS_HASH;
      const linked = seq === expectedSeq && Buffer.from(row.prev_hash).equals(expectedPrev);
      const hash = Buffer.from(row.hash);
      if (!linked || !chainHash(row.prev_hash, row).equals(hash)) return String(row.chain_seq);
      previous = { seq, hash };
      return null;
    },
  };
}

/** Premier `chain_seq` rompu d'une chaîne complète triée, ou `null` si elle est intacte. */
export function firstBrokenSeq(rows) {
  const verifier = createChainVerifier();
  for (const row of rows) {
    const broken = verifier.push(row);
    if (broken) return broken;
  }
  return null;
}
