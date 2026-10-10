# syntax=docker/dockerfile:1.7
# The workbench: one image for an Architect's sandbox, the live preview, and the build and check
# steps of publishing. Each role gets its own mounts and network from the supervisor.
#
# It contains no AI assistant. Architects install Claude Code or Codex themselves, with the
# vendor's own installer, into their own volumes (see docs/compliance.md).
# Same Playwright version as @ats/qa-browser's playwright dependency (the browsers must match).
FROM mcr.microsoft.com/playwright:v1.64.0-noble@sha256:06a9939e57531807f8d5fd76ce44b53165ffb7d7501d87ab10e285c20b1e971f AS base
# Blender (GPL, Ubuntu's own package, run unmodified as a separate program; its source is
# Ubuntu's blender source package) lets the assistant model, texture and render on the CPU.
# NumPy is what Blender's glTF exporter needs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini tmux git jq zstd ripgrep ffmpeg less nano ca-certificates \
      blender python3-numpy fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
# A real pnpm (not a corepack shim, which would try to download itself later).
RUN npm install -g pnpm@10.13.1 && npm cache clean --force

FROM base AS deps
WORKDIR /opt/ats
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpmfile.cjs ./
COPY packages/qa/package.json packages/qa/
COPY packages/qa-browser/package.json packages/qa-browser/
COPY packages/shared/package.json packages/shared/
COPY packages/bridge-protocol/package.json packages/bridge-protocol/
COPY packages/portal-sdk/package.json packages/portal-sdk/
COPY packages/ats-cli/package.json packages/ats-cli/
COPY packages/space-builder/package.json packages/space-builder/
COPY packages/space-format/package.json packages/space-format/
COPY packages/assets/package.json packages/assets/
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --prod --ignore-scripts \
      --filter @ats/qa-browser... --filter @allthespaces/ats-cli... --filter @ats/space-builder...

FROM base AS runtime
COPY --from=deps /opt/ats /opt/ats
COPY tsconfig.base.json tsconfig.node.json /opt/ats/
COPY packages/qa/src /opt/ats/packages/qa/src
COPY packages/qa-browser/src /opt/ats/packages/qa-browser/src
COPY packages/shared/src /opt/ats/packages/shared/src
COPY packages/bridge-protocol /opt/ats/packages/bridge-protocol
COPY packages/portal-sdk /opt/ats/packages/portal-sdk
COPY packages/ats-cli/src /opt/ats/packages/ats-cli/src
COPY packages/space-builder/src /opt/ats/packages/space-builder/src
COPY packages/space-builder/blender /opt/ats/packages/space-builder/blender
COPY packages/space-format/src /opt/ats/packages/space-format/src
COPY packages/assets/src /opt/ats/packages/assets/src
COPY samples /opt/ats/samples
COPY examples /opt/ats/examples
COPY starters/creation /opt/ats/starters/creation
COPY images/workbench/tmux.conf /etc/tmux.conf
COPY images/workbench/prompt.bashrc /tmp/prompt.bashrc
# The folders under .claude-config and .codex are where a workspace's own conversations are
# mounted (CONVERSATIONS in the supervisor): a new volume over one starts as the sandbox user's.
RUN cat /tmp/prompt.bashrc >> /etc/bash.bashrc && rm /tmp/prompt.bashrc \
 && rm -rf /opt/ats/examples/*/node_modules /opt/ats/examples/*/dist /opt/ats/starters/creation/node_modules \
 && printf '#!/bin/sh\nexec node /opt/ats/packages/ats-cli/src/cli.ts "$@"\n' > /usr/local/bin/ats \
 && chmod 755 /usr/local/bin/ats \
 && useradd --uid 2000 --create-home --home-dir /home/architect --shell /bin/bash architect \
 && mkdir -p /workspace /out /job /store /home/architect/.local/bin /home/architect/.claude-config /home/architect/.codex /home/architect/.cache \
    /home/architect/.claude-config/projects /home/architect/.codex/sessions /home/architect/.codex/memories \
 && chown -R architect:architect /workspace /out /job /store /home/architect

# The system's programs first, the Architect's tools volume (~/.local, writable from every
# sandbox) last: a program planted there under a system program's name never runs in its place.
# The supervisor sets the same PATH on the containers that have that volume.
ENV HOME=/home/architect \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/architect/.local/bin \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    ATS_QA_CLI=/opt/ats/packages/qa-browser/src/cli.ts \
    ATS_SPACE_CLI=/opt/ats/packages/space-builder/src/space-cli.ts \
    NODE_USE_ENV_PROXY=1 \
    npm_config_ignore_scripts=true \
    CLAUDE_CONFIG_DIR=/home/architect/.claude-config \
    CODEX_HOME=/home/architect/.codex \
    DISABLE_AUTOUPDATER=1 \
    TERM=xterm-256color \
    LANG=C.UTF-8
USER architect
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["sleep", "infinity"]
