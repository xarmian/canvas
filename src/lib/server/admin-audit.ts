/**
 * Write side of the admin audit log (see `admin_audit_log` in
 * `db/schema.ts`).
 *
 * Append-only by design: callers never update or delete rows here.
 * The schema is intentionally open on `action` + `payload` so adding
 * new admin actions doesn't require a migration each time — we just
 * keep documenting which action names exist below.
 *
 * Known `action` values:
 *
 *   - `force_delete_user_renders` — TASK-186 / PLAN-180.
 *     payload: `{ deletedRenderCount: number }`
 *
 * Add new entries to this list when wiring a new action so the
 * vocabulary stays discoverable.
 */
import { db } from './db';
import { adminAuditLog } from './db/schema';

export type AdminAuditInput = {
	actor: { id: string; email: string };
	action: string;
	targetUserId?: string | null;
	payload?: Record<string, unknown>;
};

export async function recordAdminAction(input: AdminAuditInput): Promise<void> {
	await db.insert(adminAuditLog).values({
		actorId: input.actor.id,
		actorEmail: input.actor.email,
		action: input.action,
		targetUserId: input.targetUserId ?? null,
		payload: input.payload ?? {}
	});
}
