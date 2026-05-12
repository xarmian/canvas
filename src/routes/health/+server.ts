import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

/**
 * Minimal liveness probe for Docker / nginx-proxy / external monitors.
 *
 * Scope (TASK-76): just returns 200 so a HEALTHCHECK directive in the
 * Dockerfile has a stable path to hit. This intentionally does NOT
 * check downstream dependencies (Postgres, S3) — TASK-73 owns the
 * production-grade `/health` (DB ping, structured log line on each
 * probe, optional Sentry hook). Keeping this stub liveness-only
 * means the container is reported healthy whenever Node is up and
 * serving requests, which is the right signal for "should the
 * orchestrator restart me?" Readiness probes that actually depend
 * on Postgres being reachable belong elsewhere — see TASK-73.
 *
 * The handler intentionally bypasses every middleware concern: no
 * auth, no rate limiting, no body parsing. Some health-check
 * monitors poll once a second; we don't want any of that cost on a
 * hot loop.
 */
export const GET: RequestHandler = () => {
	return json({ status: 'ok' });
};
