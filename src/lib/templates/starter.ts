/**
 * Starter template seeded by the dashboard "Try an example" flow.
 *
 * A 1200×630 OG card with:
 * - A large headline bound to a `?title=` URL parameter (default "Hello from Canvas")
 * - A subtitle bound to `?subtitle=` (default "Design once, share anywhere")
 * - An accent bar whose fill is bound to `?accent=` (default teal)
 *
 * The JSON shape mirrors what Fabric.js produces via toObject(['paramBindings']),
 * so it round-trips through /api/canvas POST -> load -> editor hydration without
 * special casing. Keep it inline rather than fetching from storage so the
 * first-run experience works on a fresh install with no assets provisioned.
 */

export const STARTER_CANVAS = {
	name: 'Example: Dynamic OG Card',
	width: 1200,
	height: 630,
	backgroundType: 'color' as const,
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
				paramBindings: {
					fill: { param: 'accent', default: '#14b8a6' }
				}
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
				selectable: true,
				evented: true,
				paramBindings: {
					text: { param: 'title', default: 'Hello from Canvas' }
				}
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
				selectable: true,
				evented: true,
				paramBindings: {
					text: { param: 'subtitle', default: 'Design once, share anywhere' }
				}
			},
			{
				type: 'Textbox',
				left: 110,
				top: 540,
				width: 1020,
				text: 'Try appending ?title=Your%20Headline to the URL',
				fontFamily: 'Inter',
				fontSize: 18,
				fontWeight: 400,
				fill: '#64748b',
				textAlign: 'left',
				selectable: true,
				evented: true
			}
		]
	}
};
