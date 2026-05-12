#!/usr/bin/env bash
# =============================================================================
# Canvas — Production deploy script (TASK-76)
# =============================================================================
#
# Run this from the VPS shell, with the repo checked out at the
# location it'll keep living in (e.g. /opt/canvas):
#
#     cd /opt/canvas && ./scripts/deploy.sh
#
# What it does:
#   1. Fast-forwards the working tree to origin/main.
#   2. Rebuilds the `app` image. db/minio/minio-init images are
#      pinned (postgres:16-alpine, minio/minio) so no need to rebuild.
#   3. Recreates ONLY the `app` container. db, minio, and the
#      nginx-proxy/acme-companion stack on the external network
#      keep running through the deploy.
#   4. Polls Container.State.Health.Status for up to 90s, exits
#      non-zero if the new container never reaches `healthy`.
#
# "Brief downtime acceptable" was the v0.4 scope agreement
# (TASK-76). Zero-downtime deploy (blue-green / rolling) is parked
# for a future plan — most VPS Canvases will absorb the ~5s gap
# fine, and operators with tighter SLAs can run two app replicas
# behind nginx-proxy with their own restart sequencing.
# =============================================================================

set -euo pipefail

# Resolve repo root regardless of where the user invoked us from.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

COMPOSE_FILE="docker-compose.prod.yml"
SERVICE="app"

if [ ! -f "$COMPOSE_FILE" ]; then
	echo "[deploy] $COMPOSE_FILE not found in $REPO_ROOT — wrong directory?"
	exit 1
fi

if [ ! -f ".env" ]; then
	echo "[deploy] .env not found. Copy .env.example.prod to .env first."
	exit 1
fi

echo "[deploy] (1/4) pulling latest from origin/main"
git pull --ff-only origin main

echo "[deploy] (2/4) building $SERVICE image"
docker compose -f "$COMPOSE_FILE" build "$SERVICE"

echo "[deploy] (3/4) recreating $SERVICE (db/minio untouched)"
# `--no-deps` keeps the dependent containers running. Without it,
# compose would restart db + minio too, which is unnecessary work
# and adds DB-reconnect churn for the new app container.
docker compose -f "$COMPOSE_FILE" up -d --no-deps "$SERVICE"

echo "[deploy] (4/4) waiting for $SERVICE to report healthy"

# Resolve the new container ID after the recreate. Without explicit
# resolution we'd race against compose finishing the swap.
container_id="$(docker compose -f "$COMPOSE_FILE" ps -q "$SERVICE")"
if [ -z "$container_id" ]; then
	echo "[deploy] could not find $SERVICE container after recreate"
	exit 1
fi

# 90s budget = 30 polls × 3s. Migrations + Node startup typically
# land inside 10–15s; the slack covers cold Sharp/Skia binding load
# and any first-boot drizzle migration run.
for i in $(seq 1 30); do
	status="$(docker inspect --format='{{.State.Health.Status}}' "$container_id" 2>/dev/null || echo 'starting')"
	if [ "$status" = "healthy" ]; then
		echo "[deploy] $SERVICE is healthy (took ~${i}×3s)"
		exit 0
	fi
	if [ "$status" = "unhealthy" ]; then
		echo "[deploy] $SERVICE is unhealthy — recent logs:"
		docker compose -f "$COMPOSE_FILE" logs --tail=100 "$SERVICE"
		exit 1
	fi
	sleep 3
done

echo "[deploy] timed out after 90s waiting for healthy state. Recent logs:"
docker compose -f "$COMPOSE_FILE" logs --tail=100 "$SERVICE"
exit 1
