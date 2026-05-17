# syntax=docker/dockerfile:1
# check=skip=SecretsUsedInArgOrEnv
#
# The check=skip directive silences BuildKit's SecretsUsedInArgOrEnv
# warning for the build stage's STUB env vars (DATABASE_URL,
# BETTER_AUTH_SECRET, BETTER_AUTH_URL). These values are hard-coded
# placeholders required by SvelteKit's prerender pass — they are
# NEVER reachable at runtime because the runner stage starts fresh
# from node:22-bookworm-slim with no inherited env. The real secrets
# are injected via docker-compose's `env_file: .env` at deploy time.
# =============================================================================
# Canvas — Production Dockerfile (TASK-76)
# =============================================================================
#
# Multi-stage build optimized for image size and security:
#
#   deps     Full dev+prod install — needed to build the SvelteKit app
#            AND so sharp's postinstall native build runs (gated by
#            package.json's `pnpm.onlyBuiltDependencies`).
#   build    Compiles the app with `pnpm build` → ./build (adapter-node
#            output: server entry + bundled client assets), then runs
#            `pnpm prune --prod` to drop dev-only deps in place. The
#            pruned node_modules retains sharp's already-built native
#            binary — running a fresh `--prod` install in a separate
#            stage would re-trigger pnpm 10's ERR_PNPM_IGNORED_BUILDS
#            for the transitive deps we don't whitelist (canvas,
#            esbuild). Pruning side-steps the build-script policy.
#   runner   Minimal runtime: node:22-bookworm-slim + a handful of
#            system deps + the built output + pruned node_modules.
#            Runs the migrator on start, then the SvelteKit server.
#            Non-root.
#
# Size budget: ~400MB compressed. The major contributors are the
# native binaries: @napi-rs/canvas (~60MB unpacked, ships its own
# Skia build) and sharp (~30MB unpacked, statically links libvips
# for AVIF/WebP encoding). The Debian-slim base adds ~80MB.
# Everything else (built JS, drizzle migrations, prod deps) is
# dwarfed by those two.
#
# Why Debian (bookworm-slim) instead of Alpine: @napi-rs/canvas's
# prebuilt binary targets glibc; on musl (Alpine) it falls back to a
# slower path or fails to load. fontconfig (needed for canvas text
# rendering) is also better-tested on Debian.
# =============================================================================

# --- Stage 1: deps — full install for build tooling -------------------------
FROM node:22-bookworm-slim AS deps

# Pin pnpm to the version CI uses (.github/workflows/lighthouse.yml).
# pnpm 11+ ships stricter build-script enforcement that errors out on
# transitive deps with install hooks (canvas, esbuild) even when only
# sharp is whitelisted in pnpm.onlyBuiltDependencies. Pinning to 10
# keeps Docker installs in lockstep with what already works in CI.
RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app
# Workspace install: root manifest + lockfile + workspace declarations,
# plus each workspace package's package.json so pnpm can resolve the
# dependency graph before any source is copied. This preserves the
# cache-friendly "deps before code" pattern under the pnpm-workspace
# layout introduced in TASK-217.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json ./apps/web/
# `--frozen-lockfile` guarantees reproducible builds; CI / deploys
# should refuse to install anything not pinned in pnpm-lock.yaml.
# Sharp's native binary build runs here (whitelisted by
# `pnpm.onlyBuiltDependencies` in the root package.json).
RUN pnpm install --frozen-lockfile


# --- Stage 2: build — compile the SvelteKit app + prune dev deps -----------
FROM node:22-bookworm-slim AS build

# Pin pnpm to the version CI uses (.github/workflows/lighthouse.yml).
# pnpm 11+ ships stricter build-script enforcement that errors out on
# transitive deps with install hooks (canvas, esbuild) even when only
# sharp is whitelisted in pnpm.onlyBuiltDependencies. Pinning to 10
# keeps Docker installs in lockstep with what already works in CI.
RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app
# Copy the workspace's installed node_modules layout. pnpm puts the
# real content under root `node_modules/.pnpm/`; each workspace
# package gets its own `node_modules/` with symlinks pointing at the
# root store, so we need both.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY . .

# SvelteKit's prerender / route-analyse pass eagerly evaluates every
# `+page.server.ts` and library import, which means `src/lib/server/
# db/index.ts` and the Better Auth init throw on missing env at
# module-load time even though the build itself doesn't connect to
# Postgres or sign anything. Mirror the stub-env pattern the CI
# build uses (see .github/workflows/lighthouse.yml) — these values
# are never reachable at runtime because the runner stage doesn't
# carry them forward, and the real `.env` is injected by
# docker-compose at `docker compose up` time.
ENV DATABASE_URL=postgresql://stub:stub@127.0.0.1:5432/stub
ENV BETTER_AUTH_SECRET=stub-secret-build-only
ENV BETTER_AUTH_URL=http://127.0.0.1:4173

# Build the `web` workspace package. Output lands at
# `apps/web/build` per adapter-node. The runner stage copies from
# there.
RUN pnpm --filter web build


# --- Stage 3: prod-deps — production-only install ---------------------------
# A separate stage because the `build` stage's `node_modules` keeps
# the full .pnpm content-addressable store, which includes ~200MB of
# devDeps (typescript, three esbuild builds, vite, rolldown, …) that
# we don't want in the runtime image. `pnpm prune --prod` doesn't
# garbage-collect the .pnpm store; `pnpm deploy --prod` requires a
# workspace which we don't have. A fresh `--prod` install in its own
# stage is the cleanest path.
FROM node:22-bookworm-slim AS prod-deps

RUN corepack enable && corepack prepare pnpm@10 --activate

WORKDIR /app
# Same workspace-aware install pattern as the deps stage, but with
# `--prod` so devDependencies are excluded.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json ./apps/web/

# `--config.strict-build-scripts=false` downgrades pnpm 10's
# unapproved-build-script policy from a hard error to a warning. We
# only have `sharp` whitelisted in `pnpm.onlyBuiltDependencies`
# (root package.json); transitive deps like esbuild and canvas have
# install scripts pnpm would otherwise refuse to skip silently. The
# warnings still print so a future maintainer can see what's being
# skipped, but the install succeeds.
#
# Sharp itself runs its postinstall here, fetching the prebuilt
# libvips binary the runner stage will use.
RUN pnpm install --frozen-lockfile --prod --config.strict-build-scripts=false


# --- Stage 3: runner — minimal runtime --------------------------------------
FROM node:22-bookworm-slim AS runner

# Runtime native dependencies:
#   fontconfig       — @napi-rs/canvas resolves font families through
#                      fontconfig at render time. Without it, text
#                      layers fall back to the embedded default and
#                      ignore user-uploaded font assets.
#   ca-certificates  — outbound TLS to Let's Encrypt / S3 / SMTP.
#   wget             — used by the Dockerfile HEALTHCHECK below; tiny
#                      enough that adding it is cheaper than carrying
#                      a busybox/curl alternative.
# sharp's prebuilt binary statically links libvips, so no libvips
# package is needed at runtime — saves ~30MB.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		fontconfig \
		ca-certificates \
		wget \
	&& rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Pre-create the render-cache mount point as the `node` user. The
# docker-compose volume `render_cache` mounts at /data/cache/render
# and inherits the ownership of the mount point at first mount; if
# we waited for Docker to create the dir at mount time it would be
# root-owned, and the `node` user's renderCache.set() calls would
# 500 with EACCES on every cache miss. (Codex round 1 P1.)
RUN mkdir -p /data/cache/render && chown -R node:node /data

# Preserve the workspace layout in the runtime image. pnpm doesn't
# hoist workspace package deps to the root `node_modules`; instead,
# `apps/web/node_modules/` carries symlinks pointing into the root
# pnpm content-addressable store at `node_modules/.pnpm/`. Node's
# resolver only finds those deps when the running module lives under
# `apps/web/` — flattening the build to `/app/build` (as the
# pre-monorepo Dockerfile did) breaks `import 'postgres'` and friends
# at startup. (Codex round 1 P1.)
#
# So: keep everything under `/app/apps/web/`, set WORKDIR there, and
# let `<cwd>/static`, `<cwd>/build`, `<cwd>/drizzle`, `<cwd>/scripts`
# resolve naturally.

# Built application output (SvelteKit adapter-node bundle).
COPY --from=build --chown=node:node /app/apps/web/build ./apps/web/build

# Bundled static assets (fonts, robots.txt). `src/lib/engine/fonts.ts`
# loads Inter-Regular/Bold from `<cwd>/static/fonts` via direct
# filesystem reads — without these the render path silently falls
# back to system fonts (DejaVuSans / Liberation), which alters text
# metrics enough to break OG-card layouts. (Codex round 1 P2 of the
# original Dockerfile review.)
COPY --from=build --chown=node:node /app/apps/web/static ./apps/web/static

# Production-only node_modules from the prod-deps stage. Both the root
# `node_modules` (containing the `.pnpm` store + workspace-level
# symlinks) and the per-package `apps/web/node_modules` (symlinks into
# `.pnpm`) are required for Node's resolver to find every dep.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=prod-deps --chown=node:node /app/apps/web/node_modules ./apps/web/node_modules

# package.json files are needed at runtime for `type: module` resolution
# at every level Node walks during import resolution.
COPY --chown=node:node package.json pnpm-workspace.yaml ./
COPY --chown=node:node apps/web/package.json ./apps/web/package.json

# Drizzle SQL migrations + the runtime migrator. Together these
# replace the dev-time `drizzle-kit migrate` command.
COPY --chown=node:node apps/web/drizzle ./apps/web/drizzle
COPY --chown=node:node apps/web/scripts/run-migrations.mjs ./apps/web/scripts/run-migrations.mjs

# Sweep CLI for `rendered_images` cleanup (TASK-175). Operator runs
# this on a cron / systemd timer — see README "Operations". Plain
# `.mjs` so it works against the production runtime without tsx.
COPY --chown=node:node apps/web/scripts/renders-sweep.mjs ./apps/web/scripts/renders-sweep.mjs

# Retention sweep for `render_events` (TASK-194). Same cron shape as
# `renders-sweep`; see README "Render event log" for the cron pattern
# and the `RENDER_EVENTS_RETENTION_DAYS` knob.
COPY --chown=node:node apps/web/scripts/render-events-sweep.mjs ./apps/web/scripts/render-events-sweep.mjs

# Switch into the web workspace so node_modules resolution + cwd-
# relative reads (static/, build/) work as the app expects.
WORKDIR /app/apps/web

# Run as the unprivileged `node` user that's baked into the official
# Node images. The image's process should not have root inside the
# container — defense-in-depth against any container-escape bug in
# our render path (Skia / Sharp parse untrusted image bytes).
USER node

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Docker healthcheck → `/health` (TASK-76 acceptance). nginx-proxy +
# the deploy script both inspect Container.State.Health.Status, so
# this is the single source of truth for "is the app alive?". The
# `/health` route is intentionally a 200-only stub today; TASK-73
# will extend it with DB ping + structured logging.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
	CMD wget -q --spider http://localhost:3000/health || exit 1

# Apply pending migrations before starting the server. `sh -c` is
# needed because we're chaining two commands; the migrator exits
# non-zero on failure, short-circuiting the server start.
CMD ["sh", "-c", "node scripts/run-migrations.mjs && node build/index.js"]
