#!/usr/bin/env bash
# =============================================================================
# Canvas — E2E test database bootstrap
# =============================================================================
# Drops and recreates an isolated `canvas_test` Postgres database, then pushes
# the current Drizzle schema into it. Idempotent — safe to run repeatedly.
#
# Reads connection info from the running docker-compose `db` service. Requires
# `docker compose` and the `db` service to be up (see docker-compose.yml).
#
# Usage:   bash scripts/setup-test-db.sh
# Or:      pnpm test:e2e:setup
# =============================================================================

set -euo pipefail

DB_NAME="${TEST_DB_NAME:-canvas_test}"
DB_USER="${TEST_DB_USER:-canvas}"
DB_HOST="${TEST_DB_HOST:-localhost}"
DB_PORT="${TEST_DB_PORT:-5432}"
DB_PASSWORD="${TEST_DB_PASSWORD:-canvas}"
COMPOSE_SERVICE="${TEST_DB_COMPOSE_SERVICE:-db}"

TEST_DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

cd "$(dirname "$0")/.."

# Sanity: the dev `db` container must be up. We exec psql inside it so this
# script doesn't require psql installed on the host.
if ! docker compose ps --status running --services | grep -q "^${COMPOSE_SERVICE}$"; then
	echo "[setup-test-db] docker compose service '${COMPOSE_SERVICE}' is not running." >&2
	echo "[setup-test-db] Start it with: docker compose up -d ${COMPOSE_SERVICE}" >&2
	exit 1
fi

echo "[setup-test-db] Resetting database '${DB_NAME}' on ${DB_HOST}:${DB_PORT}..."

# Terminate any lingering connections, then drop+create. Use the `postgres`
# maintenance database so we never try to drop a DB we're connected to.
docker compose exec -T "${COMPOSE_SERVICE}" \
	psql -v ON_ERROR_STOP=1 -U "${DB_USER}" -d postgres <<SQL
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = '${DB_NAME}' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS ${DB_NAME};
CREATE DATABASE ${DB_NAME} OWNER ${DB_USER};
SQL

echo "[setup-test-db] Pushing Drizzle schema into '${DB_NAME}'..."

# drizzle-kit push reads DATABASE_URL via dotenv. Override it here so the dev
# DB is never touched.
DATABASE_URL="${TEST_DATABASE_URL}" pnpm exec drizzle-kit push --force

echo "[setup-test-db] Ready: ${TEST_DATABASE_URL}"
