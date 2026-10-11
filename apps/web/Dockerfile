# syntax=docker/dockerfile:1
# Image du BFF web GHMT (Next.js, docs/11 §6.6). Contexte de construction : la RACINE du dépôt.
#   docker build -f apps/web/Dockerfile -t ghmt-web .
# Ne jamais publier ce conteneur : seul le proxy de bordure l'atteint (docs/11 D11, infra/deploy/README.md).
ARG NODE_IMAGE=node:22.23.3-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402

FROM ${NODE_IMAGE} AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --filter @ghmt/web...
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @ghmt/shared build && pnpm --filter @ghmt/web build
# `pnpm deploy` lie @ghmt/shared au dépôt par un lien symbolique : on le remplace par une copie réelle (build compris).
RUN pnpm --filter @ghmt/web deploy --prod --legacy /out \
 && cp -r apps/web/.next /out/.next \
 && mkdir /tmp/shared \
 && cp -rL packages/shared/dist packages/shared/package.json /tmp/shared/ \
 && rm /out/node_modules/@ghmt/shared \
 && mv /tmp/shared /out/node_modules/@ghmt/shared

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 3001
# La sonde présente le secret de bordure (sinon proxy.ts répond 403 en production).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD sh -c 's="${EDGE_PROXY_SECRET:-$(cat "$EDGE_PROXY_SECRET_FILE" 2>/dev/null)}"; wget -q -O /dev/null --header="X-Ghmt-Edge-Auth: $s" http://127.0.0.1:3001/connexion' || exit 1
CMD ["node_modules/.bin/next", "start", "-p", "3001"]
