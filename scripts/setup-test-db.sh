#!/usr/bin/env bash
# =============================================================================
# Canvas — E2E test database bootstrap
# =============================================================================
# Drops and recreates the database referenced by TEST_DATABASE_URL, then
# pushes the current Drizzle schema into it. Idempotent.
#
# Single source of truth for the test DB connection string is the
# TEST_DATABASE_URL env var (defaults to the same value baked into
# playwright.config.ts). Override one place, both the bootstrap and the
# Playwright webServer pick it up.
#
#   default: postgresql://canvas:canvas@localhost:5432/canvas_test
#
# Reads the DB via `docker compose exec` against the dev `db` service, so
# psql is not required on the host. The compose service name can be
# overridden with TEST_DB_COMPOSE_SERVICE (default: db).
#
# Usage:   bash scripts/setup-test-db.sh
# Or:      pnpm test:e2e:setup
# =============================================================================

set -euo pipefail

TEST_DATABASE_URL="${TEST_DATABASE_URL:-postgresql://canvas:canvas@localhost:5432/canvas_test}"
COMPOSE_SERVICE="${TEST_DB_COMPOSE_SERVICE:-db}"

cd "$(dirname "$0")/.."

# Parse the URL with Node so we don't bring in a sed/regex dependency. URL
# parsing in pure bash is error-prone (escaping, IPv6, etc.); Node is
# already a project dependency.
read -r DB_USER DB_PASSWORD DB_HOST DB_PORT DB_NAME < <(
	node -e '
const u = new URL(process.argv[1]);
const name = u.pathname.replace(/^\//, "");
// Trailing newline matters: under `set -e`, `read` returns 1 on EOF
// without a newline, and the whole script exits silently.
process.stdout.write([
  decodeURIComponent(u.username),
  decodeURIComponent(u.password),
  u.hostname,
  u.port || "5432",
  name
].join(" ") + "\n");
' "$TEST_DATABASE_URL"
)

if [ -z "$DB_NAME" ]; then
	echo "[setup-test-db] TEST_DATABASE_URL has no database name." >&2
	exit 1
fi

# Strict identifier whitelist. The database name is interpolated into SQL
# below, so it must not contain anything that could break out — semicolons,
# spaces, quotes, percent-encoded payloads, etc. Postgres unquoted
# identifiers already follow this shape (letter/underscore start, then
# letters/digits/underscores).
if ! [[ "$DB_NAME" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
	echo "[setup-test-db] Refusing: database name '${DB_NAME}' contains" >&2
	echo "[setup-test-db] characters outside [A-Za-z0-9_]." >&2
	exit 1
fi

# This script issues DROP DATABASE — guard against pointing it at a non-test
# database (e.g. the dev `canvas` DB). The name must contain "test"; this
# rules out 'canvas', 'postgres', and other shared DBs without preventing
# legitimate names like canvas_test, canvas_test_ci, ci_test, etc.
case "$DB_NAME" in
	*test*) ;;
	*)
		echo "[setup-test-db] Refusing to drop database '${DB_NAME}'." >&2
		echo "[setup-test-db] TEST_DATABASE_URL must point at a database whose" >&2
		echo "[setup-test-db] name contains 'test' (e.g. canvas_test)." >&2
		exit 1
		;;
esac

# Same applies to the user — used unquoted as identifier in the OWNER clause.
if ! [[ "$DB_USER" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
	echo "[setup-test-db] Refusing: user '${DB_USER}' contains characters" >&2
	echo "[setup-test-db] outside [A-Za-z0-9_]." >&2
	exit 1
fi

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
