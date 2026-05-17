/**
 * Custom Fabric properties that must be threaded through every
 * `toObject` / `clone` call in the editor so save / undo / redo /
 * duplicate all preserve them.
 *
 * Fabric only emits a fixed allowlist by default. Anything we attach via
 * `set('foo', ...)` (paramBindings, conditional rules, badge fields,
 * fallback URLs) gets dropped on serialization unless it's in this list.
 *
 * Centralized here because the list grows with every new layer-level
 * primitive (TASK-50, TASK-86, TASK-87, …) and four call sites used to
 * keep their own copies in lockstep — a recipe for drift.
 */
export const EDITOR_TO_OBJECT_PROPS = [
	// Param-binding pipeline (TASK-43+).
	'paramBindings',
	// Conditional style rules (TASK-50, TASK-85).
	'conditionalStyles',
	// Per-image fallback URL (TASK-86).
	'fallbackSrc',
	// Asset-library link tracking (TASK-116). Each *AssetId stamps which
	// library row a URL field came from so save-time translation can
	// rewrite the URL back to `asset://{id}` without re-walking the DB.
	// Survives save / undo / redo / duplicate.
	'srcAssetId',
	'fallbackSrcAssetId',
	'iconImageAssetId',
	// Badge primitive fields (TASK-87).
	'label',
	'bg',
	'fg',
	'padding',
	'radius',
	'iconImage',
	'iconPosition',
	'fontFamily',
	'fontSize',
	'fontWeight'
] as const;
