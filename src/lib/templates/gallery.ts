/**
 * Curated starter templates surfaced in /templates.
 *
 * Each template is a full POST body for /api/canvas (so the gallery's
 * "Use this template" button is just `fetch('/api/canvas', POST, body)`).
 *
 * Why hand-authored JSON (vs. fetched from storage):
 * - Works on a fresh install with no assets provisioned.
 * - Easy to grep/diff when we tune defaults.
 * - Each template stays small; the gallery tops out around 9–10 starters.
 *
 * The shape mirrors what Fabric.js produces via `toObject(['paramBindings'])`,
 * so it round-trips through the editor without special-casing. Every
 * template binds at least the headline so a brand-new user immediately
 * sees the dynamic-image story (open editor → Preview → change params).
 *
 * Keep templates "fonts-bundled-only" — they reference the BUNDLED_FONTS
 * names (Inter, Georgia, etc.) that ship with the renderer + browser,
 * so they render identically before the user has uploaded any custom
 * fonts. User fonts can still be applied after seeding.
 */

/** Bindable property → URL-param mapping with optional pipe formatter
 *  (signed-percent, currency, compact, crypto-price, …). The gallery
 *  shape mirrors the runtime ParamBinding type — defaults stay untyped
 *  here so a binding can target any property regardless of its concrete
 *  type.
 *
 *  `default` is optional: omit it (or pass undefined) and an unsupplied
 *  URL param leaves the layer's authored value in place. With a string
 *  default like `''`, the runtime `??` fallback writes that value into
 *  the property even when the user didn't pass anything — useful for
 *  text bindings, harmful for image src bindings where we want the
 *  authored URL / data-URL fallback to remain unless the user
 *  explicitly opts in. */
export interface TemplateParamBinding {
	param: string;
	default?: unknown;
	format?: string;
}

/** Conditional style rule (TASK-50 / TASK-85). Same shape as the engine's
 *  ConditionalRule — duplicated here so templates can be authored without
 *  pulling the engine types into the gallery file. */
export interface TemplateConditionalRule {
	when: { param: string; op: '==' | '!=' | '<' | '<=' | '>' | '>='; value: string };
	then: { property: 'fill' | 'opacity' | 'visible'; value: string };
}

export interface TemplateRect {
	type: 'Rect';
	left: number;
	top: number;
	width: number;
	height: number;
	fill: string;
	rx?: number;
	ry?: number;
	selectable?: boolean;
	evented?: boolean;
	paramBindings?: Record<string, TemplateParamBinding>;
	conditionalStyles?: TemplateConditionalRule[];
}

export interface TemplateText {
	type: 'Textbox';
	left: number;
	top: number;
	width: number;
	text: string;
	fontFamily: string;
	fontSize: number;
	fontWeight?: number | string;
	fill: string;
	textAlign?: 'left' | 'center' | 'right';
	selectable?: boolean;
	evented?: boolean;
	paramBindings?: Record<string, TemplateParamBinding>;
	conditionalStyles?: TemplateConditionalRule[];
}

/** Image layer with optional fallbackSrc (TASK-86). */
export interface TemplateImage {
	type: 'Image';
	left: number;
	top: number;
	width: number;
	height: number;
	src: string;
	fallbackSrc?: string;
	selectable?: boolean;
	evented?: boolean;
	paramBindings?: Record<string, TemplateParamBinding>;
	conditionalStyles?: TemplateConditionalRule[];
}

/** Badge / pill primitive (TASK-87). Auto-sized at render time;
 *  width/height in templateJson are advisory. */
export interface TemplateBadge {
	type: 'Badge';
	left: number;
	top: number;
	label: string;
	fill: string;
	fg?: string;
	padding?: number;
	radius?: number;
	iconImage?: string;
	iconPosition?: 'left' | 'right';
	fontFamily?: string;
	fontSize?: number;
	fontWeight?: number;
	visible?: boolean;
	selectable?: boolean;
	evented?: boolean;
	paramBindings?: Record<string, TemplateParamBinding>;
	conditionalStyles?: TemplateConditionalRule[];
}

export type TemplateObject = TemplateRect | TemplateText | TemplateImage | TemplateBadge;

export interface TemplateDefinition {
	/** URL-safe slug — used in the route as a key but not a URL. */
	id: string;
	/** Display name in the gallery card. */
	name: string;
	/** One-sentence description shown under the name. */
	description: string;
	/** Coarse grouping for visual sorting in the gallery. */
	category: 'social' | 'blog' | 'video' | 'commerce' | 'event' | 'generic' | 'crypto-finance';
	/** Full POST body for /api/canvas. */
	canvas: {
		name: string;
		width: number;
		height: number;
		backgroundType: 'color';
		backgroundValue: string;
		templateJson: {
			version: string;
			objects: TemplateObject[];
		};
	};
}

/**
 * The 9 curated starters. Each one is fully parameterized on its
 * primary headline so the dynamic-image story is one URL-tweak away
 * from the editor's Preview pane.
 */
export const TEMPLATES: TemplateDefinition[] = [
	{
		id: 'og-card',
		name: 'Open Graph card',
		description: 'Social link preview with bound title, subtitle, and accent.',
		category: 'social',
		canvas: {
			name: 'OG card',
			width: 1200,
			height: 630,
			backgroundType: 'color',
			backgroundValue: '#0f172a',
			templateJson: {
				version: '1.0',
				objects: [
					{
						type: 'Rect',
						left: 60,
						top: 60,
						width: 12,
						height: 510,
						fill: '#14b8a6',
						selectable: true,
						evented: true,
						paramBindings: { fill: { param: 'accent', default: '#14b8a6' } }
					},
					{
						type: 'Textbox',
						left: 110,
						top: 180,
						width: 1020,
						text: 'Hello from Canvas',
						fontFamily: 'Inter',
						fontSize: 72,
						fontWeight: 700,
						fill: '#ffffff',
						textAlign: 'left',
						paramBindings: { text: { param: 'title', default: 'Hello from Canvas' } }
					},
					{
						type: 'Textbox',
						left: 110,
						top: 320,
						width: 1020,
						text: 'Design once, share anywhere',
						fontFamily: 'Inter',
						fontSize: 32,
						fontWeight: 400,
						fill: '#cbd5e1',
						textAlign: 'left',
						paramBindings: { text: { param: 'subtitle', default: 'Design once, share anywhere' } }
					}
				]
			}
		}
	},
	{
		id: 'blog-hero',
		name: 'Blog hero',
		description: 'Long-form article header with category tag + author byline.',
		category: 'blog',
		canvas: {
			name: 'Blog hero',
			width: 1200,
			height: 630,
			backgroundType: 'color',
			backgroundValue: '#fef3c7',
			templateJson: {
				version: '1.0',
				objects: [
					{
						type: 'Textbox',
						left: 80,
						top: 80,
						width: 200,
						text: 'TUTORIAL',
						fontFamily: 'Inter',
						fontSize: 18,
						fontWeight: 700,
						fill: '#92400e',
						textAlign: 'left',
						paramBindings: { text: { param: 'category', default: 'TUTORIAL' } }
					},
					{
						type: 'Textbox',
						left: 80,
						top: 160,
						width: 1040,
						text: 'How to ship faster',
						fontFamily: 'Georgia',
						fontSize: 84,
						fontWeight: 700,
						fill: '#1c1917',
						textAlign: 'left',
						paramBindings: { text: { param: 'title', default: 'How to ship faster' } }
					},
					{
						type: 'Textbox',
						left: 80,
						top: 500,
						width: 1040,
						text: 'By Jane Doe · 5 min read',
						fontFamily: 'Inter',
						fontSize: 24,
						fontWeight: 400,
						fill: '#57534e',
						textAlign: 'left',
						paramBindings: { text: { param: 'byline', default: 'By Jane Doe · 5 min read' } }
					}
				]
			}
		}
	},
	{
		id: 'tweet-card',
		name: 'Tweet card',
		description: 'Quote-style social card sized for Twitter/X link previews.',
		category: 'social',
		canvas: {
			name: 'Tweet card',
			width: 1200,
			height: 675,
			backgroundType: 'color',
			backgroundValue: '#ffffff',
			templateJson: {
				version: '1.0',
				objects: [
					{
						type: 'Rect',
						left: 80,
						top: 100,
						width: 8,
						height: 80,
						fill: '#1d9bf0'
					},
					{
						type: 'Textbox',
						left: 120,
						top: 110,
						width: 1000,
						text: '"Best tool I\'ve used all year."',
						fontFamily: 'Georgia',
						fontSize: 56,
						fontWeight: 400,
						fill: '#0f172a',
						textAlign: 'left',
						paramBindings: { text: { param: 'quote', default: '"Best tool I\'ve used all year."' } }
					},
					{
						type: 'Textbox',
						left: 120,
						top: 460,
						width: 1000,
						text: '— Happy User',
						fontFamily: 'Inter',
						fontSize: 28,
						fontWeight: 600,
						fill: '#475569',
						textAlign: 'left',
						paramBindings: { text: { param: 'attribution', default: '— Happy User' } }
					}
				]
			}
		}
	},
	{
		id: 'youtube-thumbnail',
		name: 'YouTube thumbnail',
		description: 'High-contrast 1280×720 thumbnail with bold headline.',
		category: 'video',
		canvas: {
			name: 'YouTube thumbnail',
			width: 1280,
			height: 720,
			backgroundType: 'color',
			backgroundValue: '#dc2626',
			templateJson: {
				version: '1.0',
				objects: [
					{
						type: 'Rect',
						left: 0,
						top: 540,
						width: 1280,
						height: 180,
						fill: '#0f172a'
					},
					{
						type: 'Textbox',
						left: 60,
						top: 200,
						width: 1160,
						text: 'WATCH THIS',
						fontFamily: 'Inter',
						fontSize: 140,
						fontWeight: 700,
						fill: '#ffffff',
						textAlign: 'center',
						paramBindings: { text: { param: 'title', default: 'WATCH THIS' } }
					},
					{
						type: 'Textbox',
						left: 60,
						top: 590,
						width: 1160,
						text: 'NEW VIDEO',
						fontFamily: 'Inter',
						fontSize: 56,
						fontWeight: 700,
						fill: '#fbbf24',
						textAlign: 'center',
						paramBindings: { text: { param: 'tag', default: 'NEW VIDEO' } }
					}
				]
			}
		}
	},
	{
		id: 'podcast-cover',
		name: 'Podcast cover',
		description: 'Square 1400×1400 cover art with show + episode title.',
		category: 'video',
		canvas: {
			name: 'Podcast cover',
			width: 1400,
			height: 1400,
			backgroundType: 'color',
			backgroundValue: '#1e293b',
			templateJson: {
				version: '1.0',
				objects: [
					{
						type: 'Rect',
						left: 100,
						top: 100,
						width: 1200,
						height: 1200,
						fill: '#1e293b',
						rx: 24,
						ry: 24
					},
					{
						type: 'Textbox',
						left: 150,
						top: 200,
						width: 1100,
						text: 'EPISODE 42',
						fontFamily: 'Inter',
						fontSize: 36,
						fontWeight: 700,
						fill: '#fbbf24',
						textAlign: 'center',
						paramBindings: { text: { param: 'episode', default: 'EPISODE 42' } }
					},
					{
						type: 'Textbox',
						left: 150,
						top: 560,
						width: 1100,
						text: 'The Future of Design',
						fontFamily: 'Inter',
						fontSize: 96,
						fontWeight: 700,
						fill: '#ffffff',
						textAlign: 'center',
						paramBindings: { text: { param: 'title', default: 'The Future of Design' } }
					},
					{
						type: 'Textbox',
						left: 150,
						top: 1100,
						width: 1100,
						text: 'My Show Name',
						fontFamily: 'Inter',
						fontSize: 40,
						fontWeight: 400,
						fill: '#94a3b8',
						textAlign: 'center',
						paramBindings: { text: { param: 'show', default: 'My Show Name' } }
					}
				]
			}
		}
	},
	{
		id: 'product-card',
		name: 'Product card',
		description: 'Promo with product name, tagline, and price band.',
		category: 'commerce',
		canvas: {
			name: 'Product card',
			width: 1080,
			height: 1080,
			backgroundType: 'color',
			backgroundValue: '#fafafa',
			templateJson: {
				version: '1.0',
				objects: [
					{
						type: 'Textbox',
						left: 80,
						top: 120,
						width: 920,
						text: 'NEW',
						fontFamily: 'Inter',
						fontSize: 28,
						fontWeight: 700,
						fill: '#dc2626',
						textAlign: 'left',
						paramBindings: { text: { param: 'badge', default: 'NEW' } }
					},
					{
						type: 'Textbox',
						left: 80,
						top: 200,
						width: 920,
						text: 'Wireless Headphones',
						fontFamily: 'Inter',
						fontSize: 72,
						fontWeight: 700,
						fill: '#0f172a',
						textAlign: 'left',
						paramBindings: { text: { param: 'name', default: 'Wireless Headphones' } }
					},
					{
						type: 'Textbox',
						left: 80,
						top: 380,
						width: 920,
						text: 'Studio-grade audio, all-day comfort.',
						fontFamily: 'Inter',
						fontSize: 32,
						fontWeight: 400,
						fill: '#475569',
						textAlign: 'left',
						paramBindings: {
							text: { param: 'tagline', default: 'Studio-grade audio, all-day comfort.' }
						}
					},
					{
						type: 'Rect',
						left: 80,
						top: 880,
						width: 920,
						height: 100,
						fill: '#0f172a',
						rx: 8,
						ry: 8
					},
					{
						type: 'Textbox',
						left: 80,
						top: 905,
						width: 920,
						text: '$199',
						fontFamily: 'Inter',
						fontSize: 48,
						fontWeight: 700,
						fill: '#ffffff',
						textAlign: 'center',
						paramBindings: { text: { param: 'price', default: '$199' } }
					}
				]
			}
		}
	},
	{
		id: 'event-poster',
		name: 'Event poster',
		description: 'Portrait 1080×1350 invite with date, title, and location.',
		category: 'event',
		canvas: {
			name: 'Event poster',
			width: 1080,
			height: 1350,
			backgroundType: 'color',
			backgroundValue: '#f97316',
			templateJson: {
				version: '1.0',
				objects: [
					{
						type: 'Textbox',
						left: 80,
						top: 120,
						width: 920,
						text: 'OCT 28',
						fontFamily: 'Inter',
						fontSize: 80,
						fontWeight: 700,
						fill: '#ffffff',
						textAlign: 'left',
						paramBindings: { text: { param: 'date', default: 'OCT 28' } }
					},
					{
						type: 'Rect',
						left: 80,
						top: 280,
						width: 200,
						height: 6,
						fill: '#0f172a'
					},
					{
						type: 'Textbox',
						left: 80,
						top: 340,
						width: 920,
						text: 'Design Summit',
						fontFamily: 'Inter',
						fontSize: 120,
						fontWeight: 700,
						fill: '#0f172a',
						textAlign: 'left',
						paramBindings: { text: { param: 'title', default: 'Design Summit' } }
					},
					{
						type: 'Textbox',
						left: 80,
						top: 1100,
						width: 920,
						text: '7:00 PM · The Studio',
						fontFamily: 'Inter',
						fontSize: 36,
						fontWeight: 400,
						fill: '#ffffff',
						textAlign: 'left',
						paramBindings: { text: { param: 'location', default: '7:00 PM · The Studio' } }
					}
				]
			}
		}
	},
	{
		id: 'quote-card',
		name: 'Quote card',
		description: 'Square typographic quote with attribution.',
		category: 'social',
		canvas: {
			name: 'Quote card',
			width: 1080,
			height: 1080,
			backgroundType: 'color',
			backgroundValue: '#fef9c3',
			templateJson: {
				version: '1.0',
				objects: [
					{
						type: 'Textbox',
						left: 100,
						top: 220,
						width: 880,
						text: '"The best way out is always through."',
						fontFamily: 'Georgia',
						fontSize: 64,
						fontWeight: 400,
						fill: '#0f172a',
						textAlign: 'center',
						paramBindings: {
							text: { param: 'quote', default: '"The best way out is always through."' }
						}
					},
					{
						type: 'Textbox',
						left: 100,
						top: 760,
						width: 880,
						text: '— Robert Frost',
						fontFamily: 'Inter',
						fontSize: 32,
						fontWeight: 600,
						fill: '#78350f',
						textAlign: 'center',
						paramBindings: { text: { param: 'attribution', default: '— Robert Frost' } }
					}
				]
			}
		}
	},
	{
		id: 'square-1080',
		name: 'Blank 1080×1080',
		description: 'Empty square canvas for general-purpose social posts.',
		category: 'generic',
		canvas: {
			name: 'Blank square',
			width: 1080,
			height: 1080,
			backgroundType: 'color',
			backgroundValue: '#ffffff',
			templateJson: {
				version: '1.0',
				objects: [
					{
						type: 'Textbox',
						left: 80,
						top: 480,
						width: 920,
						text: 'Your headline here',
						fontFamily: 'Inter',
						fontSize: 64,
						fontWeight: 700,
						fill: '#0f172a',
						textAlign: 'center',
						paramBindings: { text: { param: 'title', default: 'Your headline here' } }
					}
				]
			}
		}
	},
	(() => {
		// Fallback "generic token" SVG used when a tokenA/B logo URL fails
		// to load. Embedded as a data URL so the template renders the
		// fallback feature out of the box without depending on a CDN that
		// might 404 over time. Raw `#` colors here — encodeURIComponent
		// percent-encodes them once to produce `%23...`. Pre-encoding
		// would double-encode and the canvas renderer would then see
		// literal `%23...` strings as fill values.
		const GENERIC_TOKEN_FALLBACK =
			'data:image/svg+xml;utf8,' +
			encodeURIComponent(
				'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#64748b"/><text x="32" y="42" font-size="32" font-family="sans-serif" font-weight="700" text-anchor="middle" fill="#ffffff">?</text></svg>'
			);
		// LOSS_RED + GAIN_GREEN are the conditional fill targets for the
		// gain/percent + P/L texts; reused by the range badge so the
		// in_range / edge / out_of_range pill colors stay coordinated.
		const GAIN_GREEN = '#22c55e';
		const LOSS_RED = '#ef4444';
		const RANGE_GREEN = '#10b981';
		const RANGE_YELLOW = '#f59e0b';
		const RANGE_RED = '#ef4444';

		// Sample URL exercising every parameter:
		// /c/crypto-lp-card?tokenA=USDC&tokenB=ETH&gainPercent=0.125&pl=125.30
		//   &entry=0.10&mark=0.22&volume=1234567&range=in_range&rangeLabel=In+Range
		//   &boosted=true&timeframe=24h
		// `gainPercent` is fractional (0.125 → "+12.50%") because the
		// signed-percent formatter wraps Intl percent which multiplies by
		// 100. Flip gainPercent < 0 (e.g. -0.075) → red gain text + red
		// P/L. Set range=edge or out_of_range → yellow / red pill. Omit
		// `boosted` (or set it to anything other than `true`) → star badge
		// hidden.
		const lpCardTemplate: TemplateDefinition = {
			id: 'crypto-lp-card',
			name: 'Crypto LP position',
			description:
				'Liquidity-pool position card with token logos, gain/loss color, in/edge/out-of-range pill, and optional boosted star.',
			category: 'crypto-finance',
			canvas: {
				name: 'Crypto LP position',
				width: 1200,
				height: 630,
				backgroundType: 'color',
				backgroundValue: '#0f172a',
				templateJson: {
					version: '1.0',
					objects: [
						// Top accent stripe
						{
							type: 'Rect',
							left: 0,
							top: 0,
							width: 1200,
							height: 6,
							fill: '#14b8a6'
						},
						// Token A logo (image) — `src` defaults to the embedded
						// generic-token fallback so the unbound canvas renders a
						// recognizable placeholder instead of nothing (the
						// renderer skips drawing entirely when src is empty).
						// fallbackSrc kicks in if the user-provided URL fails
						// (TASK-86). The src binding intentionally omits its
						// default so an unsupplied ?tokenALogoUrl leaves the
						// authored data URL in place; only an explicit param
						// value overrides.
						{
							type: 'Image',
							left: 60,
							top: 50,
							width: 80,
							height: 80,
							src: GENERIC_TOKEN_FALLBACK,
							fallbackSrc: GENERIC_TOKEN_FALLBACK,
							paramBindings: {
								src: { param: 'tokenALogoUrl' }
							}
						},
						// Token B logo (overlapping for the "pair" effect)
						{
							type: 'Image',
							left: 130,
							top: 50,
							width: 80,
							height: 80,
							src: GENERIC_TOKEN_FALLBACK,
							fallbackSrc: GENERIC_TOKEN_FALLBACK,
							paramBindings: {
								src: { param: 'tokenBLogoUrl' }
							}
						},
						// Token-pair label — split into three layers so each side
						// is independently bound to ?tokenA / ?tokenB. Without a
						// string-composition formatter we can't merge them into a
						// single bound text, so the layout uses right-alignment
						// on the left side + left-alignment on the right side
						// with the separator pinned in between.
						{
							type: 'Textbox',
							left: 240,
							top: 60,
							width: 200,
							text: 'USDC',
							fontFamily: 'Inter',
							fontSize: 40,
							fontWeight: 700,
							fill: '#ffffff',
							textAlign: 'right',
							paramBindings: {
								text: { param: 'tokenA', default: 'USDC' }
							}
						},
						{
							type: 'Textbox',
							left: 450,
							top: 60,
							width: 30,
							text: '/',
							fontFamily: 'Inter',
							fontSize: 40,
							fontWeight: 400,
							fill: '#64748b',
							textAlign: 'center'
						},
						{
							type: 'Textbox',
							left: 490,
							top: 60,
							width: 200,
							text: 'ETH',
							fontFamily: 'Inter',
							fontSize: 40,
							fontWeight: 700,
							fill: '#ffffff',
							textAlign: 'left',
							paramBindings: {
								text: { param: 'tokenB', default: 'ETH' }
							}
						},
						// Timeframe label (e.g., 24h, 7d)
						{
							type: 'Textbox',
							left: 240,
							top: 110,
							width: 400,
							text: '24h',
							fontFamily: 'Inter',
							fontSize: 22,
							fontWeight: 500,
							fill: '#94a3b8',
							textAlign: 'left',
							paramBindings: {
								text: { param: 'timeframe', default: '24h' }
							}
						},
						// Gain percent (signed-percent formatter, conditional fill).
						// The formatter wraps Intl.NumberFormat({style:'percent'})
						// which multiplies the input by 100 — so 0.125 renders
						// as "+12.50%". The conditional rule fires on the raw
						// param value (also fractional), keeping the < 0
						// comparison correct in either form.
						{
							type: 'Textbox',
							left: 60,
							top: 220,
							width: 600,
							text: '+12.50%',
							fontFamily: 'Inter',
							fontSize: 96,
							fontWeight: 700,
							fill: GAIN_GREEN,
							textAlign: 'left',
							paramBindings: {
								text: { param: 'gainPercent', default: '0.125', format: 'signed-percent:2' }
							},
							conditionalStyles: [
								{
									when: { param: 'gainPercent', op: '<', value: '0' },
									then: { property: 'fill', value: LOSS_RED }
								}
							]
						},
						// P/L dollar (currency formatter, conditional fill)
						{
							type: 'Textbox',
							left: 60,
							top: 330,
							width: 600,
							text: '$125.30',
							fontFamily: 'Inter',
							fontSize: 36,
							fontWeight: 600,
							fill: GAIN_GREEN,
							textAlign: 'left',
							paramBindings: {
								text: { param: 'pl', default: '125.30', format: 'currency:USD' }
							},
							conditionalStyles: [
								{
									when: { param: 'gainPercent', op: '<', value: '0' },
									then: { property: 'fill', value: LOSS_RED }
								}
							]
						},
						// Static "Entry" label
						{
							type: 'Textbox',
							left: 60,
							top: 430,
							width: 200,
							text: 'Entry',
							fontFamily: 'Inter',
							fontSize: 18,
							fontWeight: 500,
							fill: '#94a3b8',
							textAlign: 'left'
						},
						// Entry price value (crypto-price formatter)
						{
							type: 'Textbox',
							left: 60,
							top: 460,
							width: 280,
							text: '$0.10',
							fontFamily: 'Inter',
							fontSize: 32,
							fontWeight: 600,
							fill: '#ffffff',
							textAlign: 'left',
							paramBindings: {
								text: { param: 'entry', default: '0.10', format: 'crypto-price' }
							}
						},
						// Static "Mark" label
						{
							type: 'Textbox',
							left: 360,
							top: 430,
							width: 200,
							text: 'Mark',
							fontFamily: 'Inter',
							fontSize: 18,
							fontWeight: 500,
							fill: '#94a3b8',
							textAlign: 'left'
						},
						// Mark price value (crypto-price formatter)
						{
							type: 'Textbox',
							left: 360,
							top: 460,
							width: 280,
							text: '$0.22',
							fontFamily: 'Inter',
							fontSize: 32,
							fontWeight: 600,
							fill: '#ffffff',
							textAlign: 'left',
							paramBindings: {
								text: { param: 'mark', default: '0.22', format: 'crypto-price' }
							}
						},
						// Static "Volume" label
						{
							type: 'Textbox',
							left: 660,
							top: 430,
							width: 200,
							text: 'Volume',
							fontFamily: 'Inter',
							fontSize: 18,
							fontWeight: 500,
							fill: '#94a3b8',
							textAlign: 'left'
						},
						// Volume value (compact formatter — exercises the third number formatter)
						{
							type: 'Textbox',
							left: 660,
							top: 460,
							width: 280,
							text: '$1.2M',
							fontFamily: 'Inter',
							fontSize: 32,
							fontWeight: 600,
							fill: '#ffffff',
							textAlign: 'left',
							paramBindings: {
								text: { param: 'volume', default: '1234567', format: 'compact:1' }
							}
						},
						// Range badge (in_range / edge / out_of_range) — fill swaps via
						// conditional rules; default is in_range (green).
						{
							type: 'Badge',
							left: 940,
							top: 50,
							label: 'In Range',
							fill: RANGE_GREEN,
							fg: '#ffffff',
							padding: 12,
							fontFamily: 'Inter',
							fontSize: 20,
							fontWeight: 600,
							paramBindings: {
								label: { param: 'rangeLabel', default: 'In Range' }
							},
							conditionalStyles: [
								{
									when: { param: 'range', op: '==', value: 'edge' },
									then: { property: 'fill', value: RANGE_YELLOW }
								},
								{
									when: { param: 'range', op: '==', value: 'out_of_range' },
									then: { property: 'fill', value: RANGE_RED }
								}
							]
						},
						// Boosted-star badge — visible only when ?boosted=true. The
						// layer defaults to hidden so an URL with `boosted`
						// omitted keeps the star off; the conditional flips it
						// visible only on an explicit `boosted == true`.
						// Using "show on positive match" rather than "hide on
						// negative match" because conditionals don't fire when
						// the param is missing — applyConditionalStyles skips
						// rules whose `when.param` resolved to undefined.
						{
							type: 'Badge',
							left: 940,
							top: 110,
							label: '★ Boosted',
							fill: '#7c3aed',
							fg: '#ffffff',
							padding: 12,
							fontFamily: 'Inter',
							fontSize: 18,
							fontWeight: 600,
							visible: false,
							conditionalStyles: [
								{
									when: { param: 'boosted', op: '==', value: 'true' },
									then: { property: 'visible', value: 'true' }
								}
							]
						},
						// Optional platform-logo image (asset:// or remote URL).
						// `src` left blank by default — drawObject skips the
						// layer when src is empty, so an unbound canvas
						// renders nothing in this slot (the user opts in by
						// supplying ?platformLogoUrl).
						{
							type: 'Image',
							left: 1080,
							top: 540,
							width: 60,
							height: 60,
							src: '',
							paramBindings: {
								src: { param: 'platformLogoUrl' }
							}
						}
					]
				}
			}
		};
		return lpCardTemplate;
	})()
];

/** Look up a template by id. Returns undefined for unknown ids; callers
 *  should treat missing as a 404. */
export function getTemplate(id: string): TemplateDefinition | undefined {
	return TEMPLATES.find((t) => t.id === id);
}
