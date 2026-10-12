// Vérifie la chaîne d'audit de CHAQUE tenant de la base désignée par les variables PG* (libpq) : utilisé par
// restore-test.sh sur la base restaurée (docs/13 D10). Sortie : une ligne JSON { tenants, rows, broken: [{ tenantId, seq }] }.
// Lecture par lots ordonnés (chain_seq) : la mémoire reste bornée quelle que soit la taille du journal.
import pg from 'pg';
import { createChainVerifier } from './audit-chain.mjs';

const BATCH_SIZE = 5000;
const COLUMNS = `tenant_id::text, chain_seq::text, occurred_at, actor_type, actor_user_id::text, session_id::text,
  ip, action, resource_type, resource_id::text, patient_id::text, outcome, changes, request_id, prev_hash, hash`;

/** Nombre de maillons lus et premier maillon rompu (ou null) de la chaîne d'un tenant. */
async function verifyTenant(client, tenantId) {
  const verifier = createChainVerifier();
  let rows = 0;
  let after = '0';
  for (;;) {
    const { rows: batch } = await client.query(
      // Tri sur la colonne bigint (qualifiée) : l'alias texte `chain_seq` de COLUMNS trierait "10" avant "9".
      `SELECT ${COLUMNS} FROM tenant.audit_logs a WHERE a.tenant_id = $1 AND a.chain_seq > $2::bigint ORDER BY a.chain_seq LIMIT ${BATCH_SIZE}`,
      [tenantId, after],
    );
    if (batch.length === 0) return { rows, broken: null };
    for (const row of batch) {
      rows += 1;
      const broken = verifier.push(row);
      if (broken) return { rows, broken };
    }
    after = batch[batch.length - 1].chain_seq;
  }
}

const client = new pg.Client();
await client.connect();
try {
  const { rows: tenants } = await client.query('SELECT DISTINCT tenant_id::text AS id FROM tenant.audit_logs ORDER BY 1');
  const broken = [];
  let rows = 0;
  for (const { id } of tenants) {
    const result = await verifyTenant(client, id);
    rows += result.rows;
    if (result.broken) broken.push({ tenantId: id, seq: result.broken });
  }
  process.stdout.write(`${JSON.stringify({ tenants: tenants.length, rows, broken })}\n`);
} finally {
  await client.end();
}
