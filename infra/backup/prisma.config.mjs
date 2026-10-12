// Configuration Prisma de l'image de sauvegarde : `prisma migrate status` contre la base RESTAURÉE (restore-test.sh).
// Schéma et migrations copiés depuis apps/api/prisma à la construction de l'image (même révision que l'API déployée).
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.RESTORE_DATABASE_URL },
});
