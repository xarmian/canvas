/**
 * Canvas-params sync + validation helpers (TASK-52).
 *
 * The `canvas_params` table holds per-canvas validation metadata: name,
 * type, required, defaultValue. Param names are auto-derived from the
 * templateJson (bindings + conditional rules); the user controls the
 * `required` flag and `type` via the publish modal.
 */
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { canvasParams } from './db/schema.js';
import { db } from './db/index.js';
import type { FabricCanvasJson } from '$lib/engine';

/** Database-handle alias so callers can pass any drizzle instance — the
 * sync runs inside a route handler, not its own context. */
type DbHandle = typeof db;

/** Walk a Fabric template and return the deduped set of param names that
 * appear either in a property binding or in a conditional rule's `when`
 * clause. First-seen default wins (matches editor's collectBoundParams). */
export interface DerivedParam {
	name: string;
	defaultValue: string | null;
}

export function deriveCanvasParams(template: FabricCanvasJson | null | undefined): DerivedParam[] {
	if (!template) return [];
	const seen = new Map<string, DerivedParam>();
	for (const obj of template.objects ?? []) {
		const objWithExtras = obj as typeof obj & {
			conditionalStyles?: Array<{ when?: { param?: string } }>;
		};
		const bindings = obj.paramBindings;
		if (bindings) {
			for (const binding of Object.values(bindings)) {
				const name = binding?.param?.trim();
				if (!name) continue;
				if (seen.has(name)) continue;
				seen.set(name, {
					name,
					defaultValue: binding.default ?? null
				});
			}
		}
		for (const rule of objWithExtras.conditionalStyles ?? []) {
			const name = rule.when?.param?.trim();
			if (!name) continue;
			if (seen.has(name)) continue;
			seen.set(name, { name, defaultValue: null });
		}
	}
	return [...seen.values()];
}

/**
 * Reconcile the canvas_params table for `canvasId` against the names
 * derived from its current templateJson. New rows get `required=false,
 * type='text'`. Rows whose name no longer appears anywhere in the
 * template are deleted. Rows whose name still exists keep their
 * user-managed flags (required, type) but get their defaultValue
 * refreshed from the binding default.
 *
 * Idempotent — calling it twice on the same template yields the same
 * canvas_params shape.
 */
export async function syncCanvasParams(
	db: DbHandle,
	canvasId: string,
	template: FabricCanvasJson | null | undefined
): Promise<void> {
	const derived = deriveCanvasParams(template);
	const derivedNames = derived.map((p) => p.name);
	const existing = await db.select().from(canvasParams).where(eq(canvasParams.canvasId, canvasId));
	const existingByName = new Map(existing.map((row) => [row.name, row]));

	// Delete rows whose name no longer appears.
	if (derivedNames.length > 0) {
		await db
			.delete(canvasParams)
			.where(and(eq(canvasParams.canvasId, canvasId), notInArray(canvasParams.name, derivedNames)));
	} else {
		await db.delete(canvasParams).where(eq(canvasParams.canvasId, canvasId));
	}

	// Insert / refresh.
	for (const p of derived) {
		const prior = existingByName.get(p.name);
		if (prior) {
			// Only refresh defaultValue from the binding; required/type are
			// user-controlled.
			if (prior.defaultValue !== p.defaultValue) {
				await db
					.update(canvasParams)
					.set({ defaultValue: p.defaultValue })
					.where(eq(canvasParams.id, prior.id));
			}
		} else {
			await db.insert(canvasParams).values({
				canvasId,
				name: p.name,
				type: 'text',
				defaultValue: p.defaultValue,
				required: false
			});
		}
	}
}

/**
 * Apply user-specified flag updates (required, type) to existing
 * canvasParams rows for this canvas. `updates` is keyed by param name so
 * the publish modal can send only the params it knows about; unknown
 * names are silently skipped. Names that are present in `updates` but
 * not yet in the table are skipped too — they'd be created by
 * syncCanvasParams the next time templateJson is saved.
 */
export interface ParamSchemaUpdate {
	name: string;
	required?: boolean;
	type?: string;
}

export async function applyParamUpdates(
	db: DbHandle,
	canvasId: string,
	updates: ParamSchemaUpdate[]
): Promise<void> {
	if (updates.length === 0) return;
	const names = updates.map((u) => u.name);
	const rows = await db
		.select()
		.from(canvasParams)
		.where(and(eq(canvasParams.canvasId, canvasId), inArray(canvasParams.name, names)));
	const byName = new Map(rows.map((r) => [r.name, r]));
	for (const u of updates) {
		const row = byName.get(u.name);
		if (!row) continue;
		const patch: Record<string, unknown> = {};
		if (u.required !== undefined) patch.required = u.required;
		if (u.type !== undefined && /^(text|number|url|boolean|date)$/i.test(u.type)) {
			patch.type = u.type.toLowerCase();
		}
		if (Object.keys(patch).length === 0) continue;
		await db.update(canvasParams).set(patch).where(eq(canvasParams.id, row.id));
	}
}

/** Validation outcome for a render request. Either every required param
 * is present (or has a default) and every typed value parses, or we
 * surface the first failure with a structured reason. */
export type ParamValidation =
	| { ok: true; resolved: Record<string, string> }
	| { ok: false; field: string; reason: string };

/** Validate URL params against a list of canvas_params rows. Returns
 * the resolved map (with defaults applied for missing optionals) on
 * success, or a structured error on failure. */
export interface ParamRow {
	name: string;
	type: string;
	defaultValue: string | null;
	required: boolean;
}

export function validateParams(
	queryParams: Record<string, string>,
	defs: ParamRow[]
): ParamValidation {
	const resolved: Record<string, string> = { ...queryParams };
	for (const def of defs) {
		const present = Object.hasOwn(queryParams, def.name);
		// Empty-string default counts as "no default" — the editor's bind
		// toggle initializes default to '' before the user types anything,
		// and we don't want that empty intermediate state to silently fall
		// through a required check. Same logic as the public renderer
		// already applies: an empty default would render the layer empty,
		// not "use the binding's intended value".
		const hasDefault = def.defaultValue !== null && def.defaultValue !== '';
		if (!present) {
			if (hasDefault) {
				resolved[def.name] = def.defaultValue as string;
				continue;
			}
			if (def.required) {
				return { ok: false, field: def.name, reason: 'missing required parameter' };
			}
			continue;
		}
		// Present — validate type.
		const value = queryParams[def.name];
		if (def.type === 'number') {
			const n = Number(value);
			if (!Number.isFinite(n)) {
				return { ok: false, field: def.name, reason: `expected a number, got "${value}"` };
			}
		}
		// 'text' / 'url' / 'date' / 'boolean' — pass-through for now;
		// stricter validation lands in a later iteration.
	}
	return { ok: true, resolved };
}
