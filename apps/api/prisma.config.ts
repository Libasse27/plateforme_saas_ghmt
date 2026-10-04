import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Les migrations s'exécutent avec le rôle propriétaire `ghmt_migrator` (jamais avec `ghmt_app`).
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env['MIGRATION_DATABASE_URL'] },
});
