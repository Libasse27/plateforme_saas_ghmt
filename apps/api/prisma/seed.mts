// Synchronisation idempotente du catalogue de permissions (packages/shared) vers platform.permissions.
// Exécuté avec le rôle propriétaire (MIGRATION_DATABASE_URL), après `prisma migrate deploy`.
import 'dotenv/config';
import pg from 'pg';
import { ALL_PERMISSIONS } from '@ghmt/shared';

const url = process.env['MIGRATION_DATABASE_URL'];
if (!url) throw new Error('MIGRATION_DATABASE_URL non défini');

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('BEGIN');
  for (const p of ALL_PERMISSIONS) {
    await client.query(
      `INSERT INTO platform.permissions (code, module_code, resource, action, is_sensitive)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (code) DO UPDATE SET is_sensitive = EXCLUDED.is_sensitive`,
      [p.code, p.moduleCode, p.resource, p.action, p.isSensitive],
    );
  }
  await client.query('COMMIT');
  process.stdout.write(`Catalogue synchronisé : ${ALL_PERMISSIONS.length} permissions\n`);
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
