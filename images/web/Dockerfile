# syntax=docker/dockerfile:1.7
# The web client (static files) served by Caddy, which also terminates TLS and routes to the services.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
COPY apps/web/package.json apps/web/
COPY packages/ui/package.json packages/ui/
COPY packages/viewer-core/package.json packages/viewer-core/
COPY packages/space-format/package.json packages/space-format/
COPY packages/bridge-protocol/package.json packages/bridge-protocol/
COPY packages/portal-sdk/package.json packages/portal-sdk/
COPY packages/shared/package.json packages/shared/
COPY packages/api-types/package.json packages/api-types/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts --filter @ats/web...
COPY tsconfig.base.json tsconfig.node.json ./
COPY packages/ui packages/ui
COPY packages/viewer-core packages/viewer-core
COPY packages/space-format packages/space-format
COPY packages/bridge-protocol packages/bridge-protocol
COPY packages/portal-sdk packages/portal-sdk
COPY packages/shared packages/shared
COPY packages/api-types packages/api-types
COPY apps/web apps/web
# The build's hidden source maps (about 12 MB) are for local debugging: nothing links to them.
RUN pnpm --filter @ats/web build && find apps/web/dist -name '*.map' -delete

FROM caddy:2.11-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f
COPY --from=build /app/apps/web/dist /srv/web
# Caddyfile normally, Caddyfile.proxy behind another reverse proxy (chosen in compose.yml); both
# import routes.caddy.
COPY deploy/compose/Caddyfile deploy/compose/Caddyfile.proxy deploy/compose/routes.caddy /etc/caddy/
