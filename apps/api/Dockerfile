# syntax=docker/dockerfile:1
# Image de l'API GHMT (docs/11 §6.6). Contexte de construction : la RACINE du dépôt.
#   docker build -f apps/api/Dockerfile -t ghmt-api .
#   docker build -f apps/api/Dockerfile --target migrate -t ghmt-api-migrate .   (migrations, tâche ponctuelle)
# Base épinglée par digest (node:22.23.3-alpine) ; mise à jour : docker buildx imagetools inspect node:22-alpine.
ARG NODE_IMAGE=node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --filter @ghmt/api...
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @ghmt/shared build \
 && pnpm --filter @ghmt/api exec prisma generate \
 && pnpm --filter @ghmt/api build
# Dépendances de production seules, sans lien vers le dépôt.
# `pnpm deploy` lie @ghmt/shared au dépôt par un lien symbolique : on le remplace par une copie réelle (build compris).
RUN pnpm --filter @ghmt/api deploy --prod --legacy /out \
 && cp -r apps/api/dist /out/dist \
 && mkdir /tmp/shared \
 && cp -rL packages/shared/dist packages/shared/package.json /tmp/shared/ \
 && rm /out/node_modules/@ghmt/shared \
 && mv /tmp/shared /out/node_modules/@ghmt/shared

# Tâche ponctuelle : `prisma migrate deploy` avec le rôle propriétaire (MIGRATION_DATABASE_URL), jamais au démarrage de l'API.
FROM build AS migrate
WORKDIR /repo/apps/api
USER node
CMD ["pnpm", "exec", "prisma", "migrate", "deploy"]

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/v1/health >/dev/null || exit 1
CMD ["node", "dist/main.js"]
