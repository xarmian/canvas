/**
 * Conditional-style rule evaluator.
 *
 * A layer can carry an array of `ConditionalRule`s. The renderer walks them
 * after parameter substitution and overrides `fill` / `opacity` for this
 * layer only when a rule's `when` clause matches the URL params (or its
 * binding default if the URL omits the param).
 *
 * Pure module — no I/O, no side effects, no framework imports — so it can
 * be exercised in unit tests and reused on the client if/when the editor
 * gains a live preview that doesn't round-trip through the server.
 */

import type { ConditionalOp, ConditionalRule, FabricObject } from './types.js';
import { coerceBoolean } from './coerce.js';

/** Compare two strings under `op`. < / <= / > / >= attempt numeric
 * comparison first; if either side isn't a finite number, fall back to
 * lexicographic comparison so the rule still has consistent semantics
 * (e.g. ordering by ISO date string). */
export function compare(left: string, op: ConditionalOp, right: string): boolean {
	switch (op) {
		case '==':
			return left === right;
		case '!=':
			return left !== right;
		case 'contains':
			return left.toLowerCase().includes(right.toLowerCase());
		case '<':
		case '<=':
		case '>':
		case '>=': {
			const ln = Number(left);
			const rn = Number(right);
			const numeric = Number.isFinite(ln) && Number.isFinite(rn);
			const a = numeric ? ln : left;
			const b = numeric ? rn : right;
			if (op === '<') return a < b;
			if (op === '<=') return a <= b;
			if (op === '>') return a > b;
			return a >= b;
		}
		default:
			return false;
	}
}

/** Build a canvas-wide map of paramName → first-seen default. Param
 * defaults are conceptually canvas-scoped (the editor's Test Parameters
 * panel dedupes the same way), so a rule on Layer B using a param that
 * Layer A bound with a default should fall back to that default. */
function buildDefaultsIndex(objects: FabricObject[]): Map<string, string> {
	const defaults = new Map<string, string>();
	for (const obj of objects) {
		if (!obj.paramBindings) continue;
		for (const binding of Object.values(obj.paramBindings)) {
			if (binding.default === undefined) continue;
			if (!binding.param) continue;
			if (!defaults.has(binding.param)) defaults.set(binding.param, binding.default);
		}
	}
	return defaults;
}

/** Resolve the value to compare against for a rule's `when.param`.
 * Priority: URL params > canvas-wide binding default for the same param
 * name > undefined. */
function resolveParam(
	paramName: string,
	params: Record<string, string>,
	defaults: Map<string, string>
): string | undefined {
	if (Object.hasOwn(params, paramName)) return params[paramName];
	return defaults.get(paramName);
}

/**
 * Evaluate every rule on every object and apply matching overrides.
 * Mutates `objects` in place — the renderer already feeds us a deep clone
 * via JSON round-trip, so we're never editing user data.
 *
 * Rules are evaluated in declaration order; later matches win, which is
 * the natural mental model for layered overrides ("if loss then red; but
 * if very-large-loss then bold-red").
 */
export function applyConditionalStyles(
	objects: FabricObject[],
	params: Record<string, string>
): void {
	const defaults = buildDefaultsIndex(objects);
	for (const obj of objects) {
		const rules = obj.conditionalStyles;
		if (!rules || rules.length === 0) continue;
		for (const rule of rules) {
			const paramName = rule.when.param;
			if (!paramName) continue;
			const left = resolveParam(paramName, params, defaults);
			if (left === undefined) continue;
			if (!compare(left, rule.when.op, rule.when.value)) continue;
			applyOverride(obj, rule);
		}
	}
}

function applyOverride(obj: FabricObject, rule: ConditionalRule): void {
	const { property, value } = rule.then;
	if (property === 'opacity') {
		const num = Number(value);
		if (Number.isFinite(num)) obj.opacity = Math.min(Math.max(num, 0), 1);
		return;
	}
	if (property === 'fill') {
		// Trust the user input — the editor will already be a color picker
		// or hex input; the renderer accepts any value Skia/Canvas2D
		// understands as a fillStyle.
		obj.fill = value;
		return;
	}
	if (property === 'visible') {
		// Reuse the same lenient string→bool semantics as URL-param
		// bindings (`coerceBoolean`) so the rule's `then.value` accepts
		// 'true'/'1'/'yes'/'on' and the negative variants. An
		// unrecognized value leaves `visible` untouched — better to skip
		// the override than to flip the layer state on a typo.
		const bool = coerceBoolean(value);
		if (bool !== undefined) obj.visible = bool;
		return;
	}
}
