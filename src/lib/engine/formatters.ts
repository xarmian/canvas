/**
 * Pipe formatters for parameter bindings.
 *
 * A binding can carry an optional `format` string like `currency:USD`,
 * `percent:1`, `signed-percent`, `number:0`, `date:short`. At render time
 * the renderer parses the format, runs the param value through the matching
 * Intl formatter, and substitutes the result into the bound text property.
 *
 * Intentionally side-effect-free and dependency-free so the same module
 * runs on the Node server (renderer) and (if needed later) in the editor.
 *
 * Format syntax:
 *   <name>          — no argument
 *   <name>:<arg>    — single string argument (e.g. currency:USD, percent:1)
 *
 * Supported formatters:
 *   - currency:CODE              ($1,234.56)
 *   - percent:digits=0           (12.3%)
 *   - signed-percent:digits=0    (+12.3% / -12.3%)
 *   - number:digits=0            (1,234.56)
 *   - date:short|long|relative   (Jan 1, 2026 / January 1, 2026 / 2 days ago)
 *
 * Unknown formatters fall through to the input string unchanged so a typo
 * doesn't blank out the user's content. Renderer logs are out of scope for
 * a pure module — the property panel surface should validate names ahead
 * of save.
 */

export interface ParsedFormat {
	name: string;
	arg?: string;
}

/** Lowercased registry of known formatter names. Editor UIs can read this
 * to populate dropdowns without re-listing the strings inline. */
export const FORMATTER_NAMES = ['currency', 'percent', 'signed-percent', 'number', 'date'] as const;
export type FormatterName = (typeof FORMATTER_NAMES)[number];

/** Parse a "name:arg" or "name" string. Whitespace is trimmed; an empty
 * input or one starting with ':' returns null so callers treat the binding
 * as unformatted. */
export function parseFormat(format: string | undefined | null): ParsedFormat | null {
	if (!format) return null;
	const trimmed = format.trim();
	if (!trimmed) return null;
	const colon = trimmed.indexOf(':');
	if (colon === -1) return { name: trimmed.toLowerCase() };
	const name = trimmed.slice(0, colon).trim().toLowerCase();
	if (!name) return null;
	const arg = trimmed.slice(colon + 1).trim();
	return { name, arg: arg.length ? arg : undefined };
}

function safeNumber(value: string): number | null {
	if (value === '' || value === null || value === undefined) return null;
	// Accept leading +/- and inputs the user might paste with stray whitespace.
	const num = Number(value);
	return Number.isFinite(num) ? num : null;
}

function digitsArg(arg: string | undefined, fallback: number): number {
	if (arg === undefined) return fallback;
	const n = Number.parseInt(arg, 10);
	if (!Number.isFinite(n)) return fallback;
	if (n < 0) return 0;
	if (n > 20) return 20; // Intl spec maximum
	return n;
}

/**
 * Apply a formatter to a string param value. Returns the formatted string,
 * or the input value untouched if:
 *   - format is empty / unparseable
 *   - the formatter expects a number but the value isn't numeric
 *   - the formatter name isn't recognised
 *
 * The fall-through semantics matter: a deployed canvas with a typo in its
 * format string should still serve the raw param value rather than blanking
 * the field.
 */
export function applyFormat(value: string, format: string | undefined | null): string {
	const parsed = parseFormat(format);
	if (!parsed) return value;

	switch (parsed.name) {
		case 'currency': {
			const num = safeNumber(value);
			const code = (parsed.arg || 'USD').toUpperCase();
			if (num === null) return value;
			try {
				return new Intl.NumberFormat('en-US', {
					style: 'currency',
					currency: code
				}).format(num);
			} catch {
				// Invalid currency code — leave the value alone.
				return value;
			}
		}
		case 'percent': {
			const num = safeNumber(value);
			if (num === null) return value;
			const digits = digitsArg(parsed.arg, 0);
			return new Intl.NumberFormat('en-US', {
				style: 'percent',
				minimumFractionDigits: digits,
				maximumFractionDigits: digits
			}).format(num);
		}
		case 'signed-percent': {
			const num = safeNumber(value);
			if (num === null) return value;
			const digits = digitsArg(parsed.arg, 0);
			// signDisplay: 'exceptZero' so 0 doesn't get a + sign while +/-
			// values both get an explicit sign. Matches the gain/loss-card
			// use case from DOC-1.
			return new Intl.NumberFormat('en-US', {
				style: 'percent',
				minimumFractionDigits: digits,
				maximumFractionDigits: digits,
				signDisplay: 'exceptZero'
			}).format(num);
		}
		case 'number': {
			const num = safeNumber(value);
			if (num === null) return value;
			const digits = digitsArg(parsed.arg, 0);
			return new Intl.NumberFormat('en-US', {
				minimumFractionDigits: digits,
				maximumFractionDigits: digits
			}).format(num);
		}
		case 'date': {
			// Accept ISO strings, RFC 2822, and milliseconds since epoch.
			const millis = safeNumber(value);
			const d = millis !== null ? new Date(millis) : new Date(value);
			if (Number.isNaN(d.getTime())) return value;
			const arg = (parsed.arg || 'short').toLowerCase();
			if (arg === 'long') {
				return new Intl.DateTimeFormat('en-US', { dateStyle: 'long' }).format(d);
			}
			if (arg === 'relative') {
				return formatRelativeDate(d);
			}
			return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' }).format(d);
		}
		default:
			return value;
	}
}

/** Relative-time helper that mirrors Intl.RelativeTimeFormat without the
 * extra ICU data load. Uses the largest unit ≥ 1 to keep output short. */
function formatRelativeDate(d: Date, now: Date = new Date()): string {
	const rtf = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' });
	const diffSec = Math.round((d.getTime() - now.getTime()) / 1000);
	const abs = Math.abs(diffSec);
	if (abs < 60) return rtf.format(diffSec, 'second');
	const diffMin = Math.round(diffSec / 60);
	if (Math.abs(diffMin) < 60) return rtf.format(diffMin, 'minute');
	const diffHr = Math.round(diffMin / 60);
	if (Math.abs(diffHr) < 24) return rtf.format(diffHr, 'hour');
	const diffDay = Math.round(diffHr / 24);
	if (Math.abs(diffDay) < 30) return rtf.format(diffDay, 'day');
	const diffMo = Math.round(diffDay / 30);
	if (Math.abs(diffMo) < 12) return rtf.format(diffMo, 'month');
	return rtf.format(Math.round(diffMo / 12), 'year');
}
