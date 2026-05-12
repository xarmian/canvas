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
COPY package.json pnpm-lock.yaml .npmrc ./
# `--frozen-lockfile` guarantees reproducible builds; CI / deploys
# should refuse to install anything not pinned in pnpm-lock.yaml.
# Sharp's native binary build runs here (whitelisted by
# `pnpm.onlyBuiltDependencies` in package.json).
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
COPY --from=deps /app/node_modules ./node_modules
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

RUN pnpm build


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
COPY package.json pnpm-lock.yaml .npmrc ./

# `--config.strict-build-scripts=false` downgrades pnpm 10's
# unapproved-build-script policy from a hard error to a warning. We
# only have `sharp` whitelisted in `pnpm.onlyBuiltDependencies`
# (package.json); transitive deps like esbuild and canvas have
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

# Built application output. SvelteKit adapter-node bundles the server
# entry, SSR code, and client assets into ./build — copying that
# single tree is everything the Node runtime needs.
COPY --from=build --chown=node:node /app/build ./build

# Production-only node_modules from the prod-deps stage. Sharp's
# native binary was built there via its postinstall hook.
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules

# package.json is needed at runtime for `type: module` resolution.
COPY --chown=node:node package.json ./

# Drizzle SQL migrations + the runtime migrator. Together these
# replace the dev-time `drizzle-kit migrate` command.
COPY --chown=node:node drizzle ./drizzle
COPY --chown=node:node scripts/run-migrations.mjs ./scripts/run-migrations.mjs

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
