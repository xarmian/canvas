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
