# syntax=docker/dockerfile:1.7
# One image for the Node services (server, realtime, worker, supervisor); the compose file picks
# the command. Node runs the TypeScript sources directly (type stripping): no build step.
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
COPY apps/server/package.json apps/server/
COPY apps/realtime/package.json apps/realtime/
COPY apps/worker/package.json apps/worker/
COPY apps/supervisor/package.json apps/supervisor/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/api-types/package.json packages/api-types/
COPY packages/storage/package.json packages/storage/
COPY packages/assets/package.json packages/assets/
COPY packages/space-format/package.json packages/space-format/
COPY packages/space-builder/package.json packages/space-builder/
COPY packages/qa/package.json packages/qa/
COPY packages/bridge-protocol/package.json packages/bridge-protocol/
COPY packages/portal-sdk/package.json packages/portal-sdk/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts \
      --filter @ats/server... --filter @ats/realtime... --filter @ats/worker... --filter @ats/supervisor...

FROM base AS runtime
ENV NODE_ENV=production HOST=0.0.0.0
COPY --from=deps /app /app
COPY tsconfig.base.json tsconfig.node.json ./
COPY packages/shared/src packages/shared/src
COPY packages/api-types/src packages/api-types/src
COPY packages/db/src packages/db/src
COPY packages/db/migrations packages/db/migrations
COPY packages/storage/src packages/storage/src
COPY packages/assets/src packages/assets/src
COPY packages/space-format/src packages/space-format/src
COPY packages/space-builder/src packages/space-builder/src
# The bake script: the server fingerprints it, so a changed script bakes again (bakes run in the
# workbench, which has its own copy).
COPY packages/space-builder/blender packages/space-builder/blender
COPY packages/qa/src packages/qa/src
# The SDK, starter and instructions go into every new creation's workspace.
COPY packages/bridge-protocol packages/bridge-protocol
COPY packages/portal-sdk packages/portal-sdk
COPY starters/creation starters/creation
COPY agent-instructions agent-instructions
COPY samples samples
COPY apps/server/src apps/server/src
COPY apps/realtime/src apps/realtime/src
COPY apps/worker/src apps/worker/src
COPY apps/supervisor/src apps/supervisor/src
RUN rm -rf starters/creation/node_modules starters/creation/dist
USER node
EXPOSE 3000 2567 3140
CMD ["node", "apps/server/src/main.ts"]
