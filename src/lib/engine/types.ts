/** Supported output image formats */
export type OutputFormat = 'png' | 'jpeg' | 'webp' | 'avif';

/** Options for rendering a canvas template */
export interface RenderOptions {
	/** Output format (default: 'png') */
	format?: OutputFormat;
	/** JPEG/WebP/AVIF quality 1-100 (default: 85) */
	quality?: number;
	/**
	 * Device pixel ratio multiplier for retina output. The render canvas
	 * is sized at `template.width * dpr × template.height * dpr` and
	 * everything (fonts, image draws, coordinates) scales linearly via
	 * `ctx.scale(dpr, dpr)`. The consumer typically sizes the rendered
	 * <img> via CSS at the original logical width, so a 2x render shows
	 * crisp on a hi-DPI screen.
	 *
	 * Cap at 3 — past that the file size grows quadratically and the
	 * visible quality benefit plateaus. Values <= 0 fall back to 1.
	 */
	dpr?: number;
	/**
	 * Pre-loaded image buffers keyed by URL. The renderer's image fetcher
	 * checks this map BEFORE its HTTP fetch path, so callers can inject
	 * trusted bytes (e.g. resolved `asset://` references loaded directly
	 * via the storage adapter — TASK-89) without going through
	 * `loadRemoteImage`'s SSRF check, which would block local-storage
	 * paths and dev-mode private S3 hosts.
	 */
	preloadedImages?: Map<string, Buffer>;
}

/** A parameter binding on a layer property */
export interface ParamBinding {
	/** URL parameter name */
	param: string;
	/** Default value if parameter is not provided */
	default?: string;
	/**
	 * Optional pipe formatter applied at render time, e.g. "currency:USD",
	 * "signed-percent:1", "date:short". See $lib/engine/formatters for the
	 * supported names and fall-through semantics. Only applies to text-typed
	 * properties (text content, not fill/src) — the renderer skips it for
	 * NUMERIC_PROPS where coercion runs instead.
	 */
	format?: string;
}

/** Parameter bindings map: property name → binding config */
export type ParamBindings = Record<string, ParamBinding>;

/** Operators supported by conditional style rules. == / != compare as
 * strings (post-coercion), <, <=, >, >= compare as numbers (with
 * fall-through to inequality if either side isn't numeric), contains is
 * a case-insensitive substring check. */
export type ConditionalOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'contains';

/** Properties that can be overridden by a conditional rule.
 *
 * - `fill` / `opacity` (TASK-50): the original red-on-loss / green-on-gain
 *   pattern.
 * - `visible` (TASK-85): boolean show/hide. Lets a rule hide a layer (a
 *   warning pill, a "boosted" star) based on a URL param's value, without
 *   the user having to bind `visible` directly to a separate boolean param.
 *
 * Precedence: when a property is BOTH bound to a URL param AND targeted by
 * a conditional rule, the conditional wins (it runs after parameter
 * substitution in `render()`). This is intentional — it lets users layer
 * "default from URL param, overridden by rule" semantics. */
export type ConditionalProperty = 'fill' | 'opacity' | 'visible';

/**
 * One conditional-styling rule on a layer. When `when.param` resolves to
 * a value that matches `when.op when.value`, the renderer overrides
 * `then.property` with `then.value` for this layer only. Rules on the
 * same layer are evaluated in order; later rules win.
 */
export interface ConditionalRule {
	when: { param: string; op: ConditionalOp; value: string };
	then: { property: ConditionalProperty; value: string };
}

/**
 * Fabric.js serialized object (simplified type for our renderer).
 * The full Fabric.js JSON is richer, but we only need these fields for rendering.
 */
export interface FabricObject {
	type: string;
	left?: number;
	top?: number;
	width?: number;
	height?: number;
	scaleX?: number;
	scaleY?: number;
	angle?: number;
	opacity?: number;
	originX?: string;
	originY?: string;
	// Text properties
	text?: string;
	fontSize?: number;
	fontFamily?: string;
	fontWeight?: string | number;
	fontStyle?: string;
	fill?: string;
	textAlign?: string;
	lineHeight?: number;
	// Image properties
	src?: string;
	crossOrigin?: string;
	/** Skip rendering when explicitly false. Bindable via paramBindings.visible
	 * (TASK-51) — boolean values like 'true'/'1' show the layer, 'false'/'0'
	 * hide it. Distinct from opacity:0, which still renders and consumes
	 * pixels. */
	visible?: boolean;
	// Our custom properties for parameter binding
	paramBindings?: ParamBindings;
	/** Conditional style overrides (TASK-50). Rules apply after param
	 * substitution — so a binding sets the base value and rules tweak it. */
	conditionalStyles?: ConditionalRule[];
}

/** Fabric.js serialized canvas JSON */
export interface FabricCanvasJson {
	version?: string;
	objects: FabricObject[];
	background?: string;
	width?: number;
	height?: number;
}

/** Template definition as stored in the database */
export interface CanvasTemplate {
	width: number;
	height: number;
	backgroundType: 'color' | 'image';
	backgroundValue: string;
	templateJson: FabricCanvasJson;
}
