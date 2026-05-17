/**
 * Pure string builders for the embed-snippet tabs in the publish modal.
 *
 * Extracted from `PublishModal.svelte` so the templating logic can be
 * unit-tested in isolation and so the upcoming TypeScript and Python
 * tabs (PLAN-206) can sit alongside the existing five generators
 * without bloating the component further.
 *
 * Each builder is intentionally pure: it takes a fully-resolved
 * {@link SnippetInput} and returns a string. The modal owns the
 * bindings → params resolution (so `liveValues` from the editor's
 * params panel can win over a binding's default), and feeds the
 * resulting name→value map in here as `query`.
 */

/** Canonical TypeScript type for each `canvas_params.type` value.
 * Sourced from the same enum the renderer and the publish-modal schema
 * editor use, but kept narrow on purpose — unknown values fall back to
 * `string` in the typed TS generator so a future schema addition can't
 * break the snippet pipeline by emitting `: unknown`. */
export type ParamType = 'text' | 'number' | 'boolean' | 'url' | 'date';

/** Per-parameter schema row consumed by `tsTyped`. The modal already
 * loads these via `GET /api/canvas/[id]/params`; we only need name +
 * type to drive the `type Params = { ... }` declaration. */
export interface ParamSchema {
	name: string;
	type: ParamType;
}

/** Inputs shared by every snippet generator.
 *
 * The modal pre-computes the bare image URL and bare share URL (no
 * query string, no `_v` token) and a query string derived from the
 * caller's resolved param map. Whether the snippet includes the
 * parameter query — and the `_v` immutable-cache token — is controlled
 * here, so the "Show with my values" / "Show placeholder" toggle in
 * the modal flows through without each generator having to re-decide. */
export interface SnippetInput {
	/** Bare image URL — e.g. `https://canvas.example.com/c/my-slug/image.png`.
	 * No query string, no `_v`. The generator appends those when
	 * `includeParams` / `versionToken` say so. */
	imageUrl: string;
	/** Bare share URL — e.g. `https://canvas.example.com/c/my-slug`.
	 * No query string. Used by the OG generator's `og:url`. */
	shareUrl: string;
	/** Canvas slug — used for HTML alt text and Markdown alt text so
	 * the snippet is self-describing when pasted into a doc. */
	slug: string;
	/** Query string starting with `?` (or empty), e.g.
	 * `?title=Hello&avatar=https%3A%2F%2Fx`. The caller is responsible
	 * for URL-encoding; {@link buildQueryString} is the canonical way to
	 * produce one from a `Record<string, string>`. */
	query: string;
	/** Unencoded name → value map — the same source `query` is derived
	 * from. Required for snippets that emit an object literal rather
	 * than a query string (TypeScript / Python tabs), so the snippet
	 * itself shows `URLSearchParams(params)` / `requests.get(..., params=)`
	 * style construction. URL/HTML/Markdown/OG/cURL generators ignore
	 * this; pass `{}` if the caller is producing only those. */
	params: Record<string, string>;
	/** Per-parameter schema info — name + declared type from the
	 * canvas_params table. Used by `tsTyped` to generate a `type Params`
	 * declaration and to coerce values to the right TypeScript literal
	 * (numbers unquoted, booleans `true`/`false`, everything else
	 * quoted). Optional — when omitted, `tsTyped` falls back to all
	 * strings, mirroring `tsSimple` shape with type annotations added.
	 * Generators that don't care about types ignore this. */
	paramSchemas?: ParamSchema[];
	/** Immutable-cache token from `GET /api/canvas/[id]/version` — when
	 * non-empty, the snippet's image URL appends `&_v=<token>` (or
	 * `?_v=<token>` if there were no other params), opting the public
	 * renderer into the 1-year immutable cache window. */
	versionToken: string | null;
	/** When `false`, the snippet renders the bare image URL — no `query`,
	 * no `_v`. Drives the publish modal's "Show with placeholder values"
	 * toggle so the same snippet doubles as generic copy/paste docs for
	 * someone who doesn't know the schema yet. */
	includeParams: boolean;
}

/** Build a `?key=value&key2=value2` query string from a flat
 * name→value map. Empty names are skipped (they'd never be lookable
 * up at runtime). Empty values are kept verbatim — passing
 * `?title=` to the public renderer is meaningful: it forces the
 * empty string instead of falling back to the binding default. The
 * caller's resolution layer is responsible for deciding whether to
 * elide a tier-falling-through value before it reaches this function. */
export function buildQueryString(params: Record<string, string>): string {
	const parts: string[] = [];
	for (const [name, value] of Object.entries(params)) {
		if (!name) continue;
		parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(value)}`);
	}
	return parts.length ? `?${parts.join('&')}` : '';
}

/** Compose the image URL the snippet should render — bare image URL
 * plus the query (if `includeParams`) plus the `_v` cache token (if
 * present). Exported because the modal uses it both inside snippet
 * generators and for the small "preview this URL" buttons in the docs
 * area. */
export function composeImageUrl(input: SnippetInput): string {
	const query = input.includeParams ? input.query : '';
	const versionPart = input.versionToken ? `${query ? '&' : '?'}_v=${input.versionToken}` : '';
	return `${input.imageUrl}${query}${versionPart}`;
}

/** HTML `<img>` snippet. width/height attrs help avoid layout shift on
 * the consuming page; Canvas's default render is 1200×630 (the OG
 * image's canonical size). */
export function htmlSnippet(input: SnippetInput): string {
	const url = composeImageUrl(input);
	return `<img src="${url}" alt="Canvas: ${input.slug}" width="1200" height="630" />`;
}

/** Markdown image snippet. Markdown doesn't support width/height, so
 * we don't try — the snippet stays minimal and lossless for Notion /
 * Obsidian / GitHub-flavored Markdown. */
export function markdownSnippet(input: SnippetInput): string {
	const url = composeImageUrl(input);
	return `![Canvas: ${input.slug}](${url})`;
}

/** OpenGraph meta tags. Emits the four canonical tags every crawler
 * understands (og:image, og:image:width, og:image:height,
 * og:image:type) plus og:image:secure_url when the URL is `https://`
 * (some older crawlers — LinkedIn, older Slack — special-case the
 * secure variant) and og:url so the share-page URL itself is
 * canonicalized.
 *
 * og:url tracks `og:image`'s parameterization: when the user toggles
 * "Include example params" off we emit the bare share URL, so a
 * parameterized og:image variant doesn't canonicalize back to the
 * unparameterized page. Mirrors the share route's behavior of
 * preserving non-reserved query params in og:url. */
export function ogSnippet(input: SnippetInput): string {
	const url = composeImageUrl(input);
	const ogUrl = input.includeParams ? `${input.shareUrl}${input.query}` : input.shareUrl;
	const lines = [
		`<meta property="og:image" content="${url}" />`,
		`<meta property="og:image:width" content="1200" />`,
		`<meta property="og:image:height" content="630" />`,
		`<meta property="og:image:type" content="image/png" />`
	];
	if (url.startsWith('https://')) {
		lines.push(`<meta property="og:image:secure_url" content="${url}" />`);
	}
	lines.push(`<meta property="og:url" content="${ogUrl}" />`);
	return lines.join('\n');
}

/** Plain-URL snippet — the snippet *is* the URL. Useful for pasting
 * into Notion / Slack / email where the rich-link unfurler renders
 * the image inline. */
export function urlSnippet(input: SnippetInput): string {
	return composeImageUrl(input);
}

/** cURL snippet — ready to drop into a terminal, downloads the PNG to
 * `canvas.png`. Public GET, no auth needed, so this is the whole
 * story. */
export function curlSnippet(input: SnippetInput): string {
	return curlFor(composeImageUrl(input));
}

/** Map a `canvas_params.type` value to its TypeScript literal type
 * (i.e. the string that goes after the `:` in `type Params = { x: T }`).
 * Unknown values defensively fall back to `string` rather than
 * `unknown` so the snippet stays runnable if the schema vocabulary
 * grows after this code ships. */
function tsTypeForParamType(type: ParamType): 'string' | 'number' | 'boolean' {
	switch (type) {
		case 'number':
			return 'number';
		case 'boolean':
			return 'boolean';
		case 'text':
		case 'url':
		case 'date':
			return 'string';
		default:
			return 'string';
	}
}

/** Render a single JS object value as its TS literal source. Numbers
 * are emitted unquoted (when the source string is finite-numeric);
 * booleans become `true`/`false`; everything else becomes a
 * single-quoted string with backslash- and quote-escaping. NaN /
 * Infinity / unparseable numeric strings fall back to the quoted form
 * to keep the snippet runnable and to keep the resulting fetch URL
 * matching what the renderer would parse back. */
function tsLiteralFor(rawValue: string, tsType: 'string' | 'number' | 'boolean'): string {
	if (tsType === 'number') {
		const n = Number(rawValue);
		return Number.isFinite(n) ? String(n) : jsString(rawValue);
	}
	if (tsType === 'boolean') {
		// Renderer currently passes string params through verbatim, so
		// the snippet should preserve whatever the user typed. We only
		// emit a real boolean literal for the canonical 'true' / 'false'
		// (case-insensitive, trimmed); anything else falls back to a
		// quoted string so the snippet stays runnable and the TS type
		// system surfaces the mismatch — same approach as the NaN case
		// for numbers above. Avoids silently rewriting 'maybe' to
		// `false` and diverging from what the bare URL form would send.
		const normalized = rawValue.trim().toLowerCase();
		if (normalized === 'true') return 'true';
		if (normalized === 'false') return 'false';
		return jsString(rawValue);
	}
	return jsString(rawValue);
}

/** Single-quoted JS string literal. Escapes backslash, single-quote,
 * and the line terminators \n / \r / U+2028 / U+2029 — the four
 * characters that would otherwise break out of a single-quoted JS
 * string and produce a syntax error in the copied snippet (Codex
 * round 1 P2). Other control characters are left verbatim — modern
 * editors render them, and an inadvertently pasted NUL or BEL is a
 * separate problem we can't anticipate from here. Unicode (BMP and
 * astral) passes through unchanged since JS source allows any
 * codepoint in a string literal. */
function jsString(value: string): string {
	return `'${value
		.replace(/\\/g, '\\\\')
		.replace(/'/g, "\\'")
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r')
		.replace(/\u2028/g, '\\u2028')
		.replace(/\u2029/g, '\\u2029')}'`;
}

/** Render an object key. Plain identifiers stay unquoted (cleaner
 * snippet); anything with spaces / hyphens / leading digits gets the
 * quoted form so the snippet stays syntactically valid. */
function jsKey(name: string): string {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : jsString(name);
}

/** Compose the URL-construction line used by both TS flavors. When a
 * version token is set the `&_v=<token>` suffix is appended after the
 * URLSearchParams expansion — the renderer reads `_v` from the raw
 * query string, so it must not go through URLSearchParams (which
 * would re-encode the `_` and the token redundantly, though
 * harmlessly). */
function tsUrlLine(input: SnippetInput, searchExpr: string): string {
	const versionTail = input.versionToken ? `&_v=${input.versionToken}` : '';
	return `const url = \`${input.imageUrl}?\${${searchExpr}}${versionTail}\`;`;
}

/** Whether the caller wants params materialized in the snippet. Both
 * TS flavors collapse to a bare-`fetch(url)` form when the toggle is
 * off or the canvas has no bindings — the snippet still demonstrates
 * the right pattern without inventing a params object out of nothing. */
function hasRenderableParams(input: SnippetInput): boolean {
	return input.includeParams && Object.keys(input.params).length > 0;
}

/** TypeScript snippet — untyped `Record<string, string>` flavor. The
 * "Simple" sub-toggle in the modal's TypeScript tab. Pure raw `fetch`,
 * no SDK dependency — TASK-213 will replace this with `CanvasClient`
 * once the SDK lands (blocked by IDEA-204 / IDEA-205). Runs on
 * Node 18+ (built-in fetch) and any modern browser. */
export function tsSimple(input: SnippetInput): string {
	if (!hasRenderableParams(input)) {
		const url = composeImageUrl(input);
		return [
			`// Fetch the rendered image.`,
			`const url = ${jsString(url)};`,
			`const res = await fetch(url);`,
			`const blob = await res.blob();`
		].join('\n');
	}
	const paramLines = Object.entries(input.params).map(([k, v]) => `\t${jsKey(k)}: ${jsString(v)}`);
	return [
		`// Fetch the rendered image. URLSearchParams safely encodes`,
		`// spaces, '+', '%', and unicode in your param values.`,
		`const params: Record<string, string> = {`,
		paramLines.join(',\n'),
		`};`,
		tsUrlLine(input, 'new URLSearchParams(params)'),
		`const res = await fetch(url);`,
		`const blob = await res.blob();`
	].join('\n');
}

/** TypeScript snippet — typed `type Params = {...}` flavor. The
 * "Typed" sub-toggle in the modal's TypeScript tab. Generates the
 * Params type from `paramSchemas` so the canvas's parameter contract
 * is enforced at compile time. Values are emitted as native TS
 * literals (numbers unquoted, booleans `true`/`false`); URLSearchParams
 * needs strings, so the snippet stringifies before encoding.
 *
 * When `paramSchemas` is omitted or doesn't cover every key in
 * `params`, missing schema entries default to `string` so the snippet
 * stays runnable. Extra schema entries that aren't in `params` are
 * still declared in the type and assigned with their default
 * placeholder (empty string / 0 / false) so the type stays a complete
 * contract of the canvas's schema, not just the values the user has
 * typed in. */
export function tsTyped(input: SnippetInput): string {
	if (!hasRenderableParams(input)) {
		const url = composeImageUrl(input);
		return [
			`// Fetch the rendered image.`,
			`const url = ${jsString(url)};`,
			`const res = await fetch(url);`,
			`const blob = await res.blob();`
		].join('\n');
	}
	// Build the canonical schema list: union of `paramSchemas` (in
	// declared order) plus any keys present in `params` but missing
	// from `paramSchemas` (treated as `text` → string). Declared order
	// matters because the type/object literals read top-to-bottom.
	const schemas = input.paramSchemas ?? [];
	const declared = new Set(schemas.map((s) => s.name));
	const extras: ParamSchema[] = Object.keys(input.params)
		.filter((k) => !declared.has(k))
		.map((name) => ({ name, type: 'text' as const }));
	const ordered = [...schemas, ...extras];

	const typeLines = ordered.map((s) => `\t${jsKey(s.name)}: ${tsTypeForParamType(s.type)};`);
	const valueLines = ordered.map((s) => {
		const ts = tsTypeForParamType(s.type);
		const raw = input.params[s.name] ?? defaultLiteralForType(ts);
		return `\t${jsKey(s.name)}: ${tsLiteralFor(raw, ts)}`;
	});
	return [
		`// Type-checked params: the canvas schema is the contract, so`,
		`// missing keys or wrong types are caught at compile time.`,
		`type Params = {`,
		typeLines.join('\n'),
		`};`,
		``,
		`const params: Params = {`,
		valueLines.join(',\n'),
		`};`,
		``,
		`// URLSearchParams needs string values — stringify per key`,
		`// before encoding so numbers and booleans flow through.`,
		`const search = new URLSearchParams(`,
		`\tObject.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]))`,
		`);`,
		tsUrlLine(input, 'search'),
		`const res = await fetch(url);`,
		`const blob = await res.blob();`
	].join('\n');
}

/** Placeholder when the caller hasn't supplied a value for a declared
 * schema key — keeps the typed snippet syntactically valid (and
 * URL-parseable) without inventing fake data. Empty string for
 * strings; `0` for numbers; `false` for booleans. The raw string here
 * is what `tsLiteralFor` will re-format into the right literal form. */
function defaultLiteralForType(tsType: 'string' | 'number' | 'boolean'): string {
	if (tsType === 'number') return '0';
	if (tsType === 'boolean') return 'false';
	return '';
}

/** Python `requests`-based snippet. Drives the publish modal's
 * Python tab (wired in TASK-211). Emits a self-contained script:
 * `import requests`, build the `params` dict (when applicable),
 * `requests.get(url, params=params)`, `raise_for_status()`, write the
 * bytes to `card.png`. Targets Python 3.9+ with `requests` installed.
 *
 * Type coercion at the Python layer (when `paramSchemas` is supplied):
 *   - number  → unquoted Python literal (`12.5`), with quoted-string
 *     fallback when the raw value isn't finite-numeric so the
 *     snippet stays runnable
 *   - boolean → quoted lowercase string (`"true"` / `"false"`), or
 *     the quoted raw value if it isn't a canonical boolean —
 *     matches the renderer, which parses query strings and so
 *     receives `"true"` regardless of whether the caller typed True
 *     or 'true'. We never emit Python's `True`/`False` literals
 *     because `requests` would stringify them to `"True"` /
 *     `"False"` (capital T/F) which the renderer wouldn't recognize.
 *   - everything else → quoted Python string with `pyString` escaping
 *
 * Without `paramSchemas`, every value is emitted as a quoted string —
 * safe default that matches what the renderer would see if the
 * snippet were sent unmodified. */
export function python(input: SnippetInput): string {
	const hasParams = hasRenderableParams(input);
	// URL literal: when a version token is set, bake `?_v=` directly
	// into the URL. requests will merge query params from the URL with
	// the `params=` dict, so baking `_v` into the URL keeps the params
	// dict free of reserved underscore-prefixed keys (cleaner
	// snippet, harder to break by editing).
	const urlLiteral = input.versionToken
		? `${input.imageUrl}?_v=${input.versionToken}`
		: input.imageUrl;

	const lines: string[] = [`import requests`, ``];

	if (hasParams) {
		const schemaTypes = new Map<string, ParamType>(
			(input.paramSchemas ?? []).map((s) => [s.name, s.type])
		);
		const paramLines = Object.entries(input.params).map(([k, v]) => {
			const t = schemaTypes.get(k);
			return `\t${pyString(k)}: ${pyLiteralFor(v, t)},`;
		});
		lines.push(`params = {`, ...paramLines, `}`, ``);
		lines.push(`response = requests.get(`, `\t${pyString(urlLiteral)},`, `\tparams=params,`, `)`);
	} else {
		lines.push(`response = requests.get(${pyString(urlLiteral)})`);
	}
	lines.push(
		`response.raise_for_status()`,
		``,
		`with open("card.png", "wb") as f:`,
		`\tf.write(response.content)`
	);
	return lines.join('\n');
}

/** Render a single value as its Python literal. Booleans use the
 * stringified form (renderer parses query strings, never sees Python
 * objects); numbers go through unquoted when finite; everything else
 * is a quoted string. */
function pyLiteralFor(rawValue: string, type: ParamType | undefined): string {
	if (type === 'number') {
		const n = Number(rawValue);
		return Number.isFinite(n) ? String(n) : pyString(rawValue);
	}
	if (type === 'boolean') {
		const normalized = rawValue.trim().toLowerCase();
		if (normalized === 'true') return pyString('true');
		if (normalized === 'false') return pyString('false');
		return pyString(rawValue);
	}
	return pyString(rawValue);
}

/** Double-quoted Python string literal. Escapes backslash, double
 * quote, newline, and carriage return — the characters that would
 * otherwise break out of a `"..."` Python string literal or change
 * its line layout. Unicode passes through unchanged: Python 3 source
 * is UTF-8 by default. */
function pyString(value: string): string {
	const escaped = value
		.replace(/\\/g, '\\\\')
		.replace(/"/g, '\\"')
		.replace(/\n/g, '\\n')
		.replace(/\r/g, '\\r');
	return `"${escaped}"`;
}

/** Shell-safe `curl -o canvas.png '<URL>'`. Exposed as a free
 * function so the publish-modal docs area can use it on the
 * un-versioned `exampleImageUrl` too (the curl row sits outside the
 * embed-tabs section and uses a different URL than the embed
 * snippets). Single-quotes the URL and escapes any single quotes
 * inside it using the standard `'\\''` ANSI-C trick — safe across
 * bash / zsh / sh. */
export function curlFor(url: string): string {
	const escaped = url.replace(/'/g, `'\\''`);
	return `curl -o canvas.png '${escaped}'`;
}
