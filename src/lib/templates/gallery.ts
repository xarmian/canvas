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
	paramBindings?: Record<string, { param: string; default: unknown }>;
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
	paramBindings?: Record<string, { param: string; default: unknown }>;
}

export type TemplateObject = TemplateRect | TemplateText;

export interface TemplateDefinition {
	/** URL-safe slug — used in the route as a key but not a URL. */
	id: string;
	/** Display name in the gallery card. */
	name: string;
	/** One-sentence description shown under the name. */
	description: string;
	/** Coarse grouping for visual sorting in the gallery. */
	category: 'social' | 'blog' | 'video' | 'commerce' | 'event' | 'generic';
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
	}
];

/** Look up a template by id. Returns undefined for unknown ids; callers
 *  should treat missing as a 404. */
export function getTemplate(id: string): TemplateDefinition | undefined {
	return TEMPLATES.find((t) => t.id === id);
}
