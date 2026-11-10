# syntax=docker/dockerfile:1
# Builds the web client (Native Shell, apps/nsh) and the bundled server, then runs as a non-root user with /data for
# the SQLite database (override with DATABASE_URL). Session backups are off unless STORAGE_URL names
# a store, such as file:///data/backups in the same volume.

# Node 24, as in .node-version, CI and the connector's engines, so CI tests the Node the image ships. Images a FROM names
# are arguments declared here, before the first FROM: one declared later is only that stage's.
ARG NODE_IMAGE=node:24-bookworm-slim
# The web stage's (below).
ARG WEB_BUILD_IMAGE=node:24-trixie-slim
FROM ${NODE_IMAGE} AS base
WORKDIR /app
# pnpm from npm, not corepack (gone from Node 25+ images), at the version packageManager in package.json names (without
# any +sha suffix, which npm doesn't take), so the two can't drift apart.
COPY package.json ./
RUN npm install -g "$(node -p 'require("./package.json").packageManager.split("+")[0]')" && npm cache clean --force

# The client as a web app: static files, the same for every platform the image is built for, so this stage runs once on
# the builder's own platform. Native Shell publishes its Linux CLI for x86_64 only, built against glibc 2.39, hence
# Debian 13 here (the runtime image doesn't need it). scripts/nsh.mjs downloads the pinned CLI and checks its SHA-256.
FROM --platform=$BUILDPLATFORM ${WEB_BUILD_IMAGE} AS web
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json packages/cli/
RUN npm install -g "$(node -p 'require("./package.json").packageManager.split("+")[0]')" && pnpm install --frozen-lockfile --ignore-scripts
COPY scripts/nsh.mjs scripts/nsh-web-fixes.mjs scripts/
# Cache the verified SDK independently of client sources; frontend edits should not redownload a large release.
RUN node --input-type=module -e "import { nshBinary } from './scripts/nsh.mjs'; await nshBinary();"
COPY apps/nsh apps/nsh
COPY packages/shared packages/shared
COPY packages/client packages/client
RUN pnpm build:client

FROM base AS build
# Only the server and connector manifests: pnpm installs just the workspaces present.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json packages/cli/
RUN pnpm install --frozen-lockfile
COPY apps/server apps/server
COPY packages/shared packages/shared
COPY packages/client packages/client
COPY tsconfig.json ./
RUN pnpm build:server
COPY --from=web /app/dist/client dist/client

FROM base AS runtime
ENV NODE_ENV=production
# The release this image is, which /api/health reports and the web app's settings show: release-server.yml passes the
# tag's version; a local build reports none.
ARG PIKIBUN_VERSION=
ENV PIKIBUN_VERSION=${PIKIBUN_VERSION}
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/cli/package.json packages/cli/
RUN pnpm install --frozen-lockfile --prod
# dist/server/migrations is produced by `pnpm build:server`; the server resolves it next to the bundle.
COPY --from=build /app/dist ./dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8787
# Workspace owners may connect a Postgres database of their own for session backups (public hosts only); set
# WORKSPACE_DATABASES=false to turn that off. People sign in with a username and password (and with GitHub, once its
# OAuth app is set), and new accounts, GitHub's too, come only through a workspace's invite link, so a server the
# internet reaches takes nobody uninvited; the first administrator comes from --create-admin. Set PASSWORD_AUTH=false,
# or SIGNUP to open or off, to change that.
ENV HOST=0.0.0.0 PORT=8787 DATABASE_URL=sqlite:///data/pikibun.sqlite WORKSPACE_DATABASES=true \
  PASSWORD_AUTH=true SIGNUP=invite
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + process.env.PORT + '/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "dist/server/main.js"]
