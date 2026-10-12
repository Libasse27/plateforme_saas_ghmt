// Configuration Prisma de scripts/ci/check-migrations.mjs : Prisma 7 ne prend plus la base fantôme en option de
// `migrate diff`, elle vient de la configuration. Schéma et migrations sont passés explicitement en ligne de commande.
// Les URL viennent de l'environnement du processus (jamais écrites ici).
export default {
  datasource: { url: process.env['MIGRATION_DATABASE_URL'], shadowDatabaseUrl: process.env['SHADOW_DATABASE_URL'] },
};
