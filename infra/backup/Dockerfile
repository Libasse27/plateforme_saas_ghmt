# syntax=docker/dockerfile:1
# Image des tâches de sauvegarde et de test de restauration (docs/13 D9, D10, §6.1). Contexte : infra/backup, plus le
# contexte nommé `prisma` (schéma et migrations de l'API ; le .dockerignore racine exclut infra/) :
#   docker build --build-context prisma=apps/api/prisma -t ghmt-backup infra/backup
# Contenu : pg_dump/pg_restore 17 et un serveur PostgreSQL 17 (instance JETABLE de restore-test.sh, jamais exposée),
# age, aws-cli, jq, Prisma (prisma migrate status sur les migrations du dépôt) et la vérification de la chaîne d'audit.
# Base épinglée par digest (même image que apps/api/Dockerfile) ; paquets Alpine épinglés par version.
ARG NODE_IMAGE=node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

FROM ${NODE_IMAGE}
RUN apk add --no-cache \
      bash=5.3.9-r1 coreutils=9.11-r0 jq=1.8.2-r0 age=1.3.2-r0 aws-cli=2.34.63-r0 \
      postgresql17=17.11-r0 postgresql17-client=17.11-r0 postgresql17-contrib=17.11-r0
WORKDIR /opt/ghmt-backup
COPY --chmod=644 package.json package-lock.json ./
# Le script d'installation de Prisma télécharge le moteur de schéma à la construction (aucun téléchargement à l'exécution).
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
# Migrations et schéma de l'API : référence de `prisma migrate status` après restauration.
COPY --from=prisma schema prisma/schema
COPY --from=prisma migrations prisma/migrations
COPY --chmod=644 prisma.config.mjs audit-chain.mjs verify-audit-chain.mjs ./
COPY --chmod=755 lib.sh backup.sh restore-test.sh prune.sh ./
# Répertoires de travail et de métriques : volumes nommés en production, initialisés avec ce propriétaire.
RUN mkdir -p /work /metrics && chown node:node /work /metrics
# Utilisateur non root : initdb et postgres refusent de tourner en root.
USER node
ENV PATH="/opt/ghmt-backup:${PATH}" BACKUP_WORK_DIR=/tmp
ENTRYPOINT []
CMD ["backup.sh"]
