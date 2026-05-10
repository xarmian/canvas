/**
 * Badge / pill primitive (TASK-87) — a custom Fabric.js shape that renders
 * a rounded-rectangle background with an auto-sized label and optional
 * icon. Mirrors the server-side `drawBadgeObject` in `engine/renderer.ts`
 * so the editor preview matches the rendered output exactly.
 *
 * Why a single FabricObject subclass instead of a Group of Rect+Text+Image:
 * - The pill auto-sizes to its content. A Group would require manually
 *   re-laying out children every time the user changes label / padding /
 *   font, and the children's coordinates would constantly drift out of
 *   sync with the group's bounding box.
 * - Param bindings target single layers (`label`, `fill`, `iconImage`,
 *   etc. live on the Badge layer itself). With a Group, bindings on
 *   `label` would have to thread through to a child IText, which the
 *   binding pipeline doesn't model.
 * - One layer, one transform. A user dragging the pill rotates / scales
 *   the whole shape, which is what they expect.
 *
 * Icon loading: an optional HTMLImageElement is loaded lazily via the
 * standard browser fetch path. asset://{id} URLs are NOT resolved here
 * (TASK-89 / TASK-116 wires the editor-side resolver); for v0.5 the
 * editor leaves the icon slot empty when the URL doesn't load — the
 * server renderer still draws the asset on publish.
 */

import { FabricObject, classRegistry, util } from 'fabric';
import type { TClassProperties, TOptions } from 'fabric';

export type BadgeIconPosition = 'left' | 'right';

export interface BadgeProps {
	label: string;
	bg: string;
	fg: string;
	padding: number;
	radius: number | undefined;
	iconImage: string;
	iconPosition: BadgeIconPosition;
	fontFamily: string;
	fontSize: number;
	fontWeight: number;
}

const BADGE_DEFAULTS: BadgeProps = {
	label: 'Badge',
	bg: '#10b981',
	fg: '#ffffff',
	padding: 10,
	radius: undefined,
	iconImage: '',
	iconPosition: 'left',
	fontFamily: 'Inter',
	fontSize: 16,
	fontWeight: 600
};

const ICON_GAP = 6;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyOptions = any;

export class Badge extends FabricObject {
	static type = 'Badge';

	static ownDefaults: Partial<TClassProperties<Badge>> = BADGE_DEFAULTS;

	declare label: string;
	declare bg: string;
	declare fg: string;
	declare padding: number;
	declare radius: number | undefined;
	declare iconImage: string;
	declare iconPosition: BadgeIconPosition;
	declare fontFamily: string;
	declare fontSize: number;
	declare fontWeight: number;

	/** Cached HTMLImageElement for the current iconImage URL. Populated by
	 *  `loadIcon()`; cleared when the URL changes. Optional — the badge
	 *  renders without it, just without a glyph. */
	_iconEl: HTMLImageElement | null = null;
	_iconUrl: string = '';
	_iconLoading: boolean = false;

	static getDefaults(): Record<string, AnyOptions> {
		return {
			...super.getDefaults(),
			...Badge.ownDefaults
		};
	}

	constructor(options?: TOptions<Partial<BadgeProps>>) {
		super();
		Object.assign(this, Badge.ownDefaults);
		this.setOptions(options as AnyOptions);
		this._syncBounds();
		// Kick off icon load so the next render frame has it.
		this._maybeLoadIcon();
	}

	/** Override `set` so any change to layout-affecting props re-syncs the
	 *  bounding box and re-loads the icon if the URL changed. Fabric's
	 *  default setter just assigns; without this hook the badge would keep
	 *  stale dimensions after a label / padding / font edit. */
	set(key: string | Record<string, AnyOptions>, value?: AnyOptions): this {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const result = super.set(key as any, value as any);
		this._syncBounds();
		this._maybeLoadIcon();
		return result;
	}

	/** Recompute width/height from the label + icon + padding. Width and
	 *  height are visual derived values; setting them also keeps Fabric's
	 *  selection bounding box correct. */
	_syncBounds(): void {
		const ctx = this._measureCtx();
		if (!ctx) return;
		ctx.font = `${this.fontWeight} ${this.fontSize}px ${this.fontFamily}`;
		const labelWidth = this.label ? ctx.measureText(this.label).width : 0;
		const iconRendered = !!this._iconEl && !!this.iconImage;
		const iconSize = iconRendered ? Math.round(this.fontSize * 1.1) : 0;
		const iconGap = labelWidth > 0 && iconRendered ? ICON_GAP : 0;
		const innerHeight = Math.max(this.fontSize, iconSize);
		const totalHeight = innerHeight + this.padding * 2;
		const totalWidth = labelWidth + (iconRendered ? iconSize + iconGap : 0) + this.padding * 2;
		this.width = Math.max(totalWidth, this.padding * 2 + 1);
		this.height = Math.max(totalHeight, this.padding * 2 + 1);
		this.setCoords();
	}

	/** Ephemeral 2D context for text measurement. We don't pay the cost of
	 *  reusing a singleton — modern browsers cache canvas creation cheaply
	 *  and a per-instance context is simpler than synchronizing a shared one. */
	_measureCtx(): CanvasRenderingContext2D | null {
		if (typeof document === 'undefined') return null;
		const c = document.createElement('canvas');
		return c.getContext('2d');
	}

	_maybeLoadIcon(): void {
		const url = this.iconImage || '';
		if (url === this._iconUrl) return;
		this._iconUrl = url;
		this._iconEl = null;
		if (!url) {
			this._syncBounds();
			this.canvas?.requestRenderAll();
			return;
		}
		// asset://{id} URLs need a server-side resolver (TASK-89 / TASK-116).
		// In the editor we don't currently translate them, so they just fail
		// to load — the badge renders without the icon and the server fills
		// the icon in on render.
		if (url.startsWith('asset://')) {
			this._syncBounds();
			this.canvas?.requestRenderAll();
			return;
		}
		this._iconLoading = true;
		util
			.loadImage(url)
			.then((img) => {
				// Stale check: another setOptions could have replaced the URL
				// while the load was in flight; ignore the result then.
				if (this._iconUrl !== url) return;
				this._iconEl = img;
				this._iconLoading = false;
				this._syncBounds();
				this.canvas?.requestRenderAll();
			})
			.catch(() => {
				if (this._iconUrl !== url) return;
				this._iconEl = null;
				this._iconLoading = false;
			});
	}

	/** Drawn at the object's center (Fabric translates -w/2, -h/2 before
	 *  calling _render). The shared draw routine in `engine/renderer.ts`
	 *  draws at top-left because the server applies originX/originY
	 *  differently — but the geometry math is the same. */
	_render(ctx: CanvasRenderingContext2D): void {
		const w = this.width;
		const h = this.height;
		const padding = this.padding;
		const iconRendered = !!this._iconEl && !!this.iconImage;
		const iconSize = iconRendered ? Math.round(this.fontSize * 1.1) : 0;

		// Origin offset (top-left of the badge in object-local coords)
		const x = -w / 2;
		const y = -h / 2;

		// Background pill
		// `fill` (used by Fabric for any object's fill) doubles as the bg
		// color so the existing param-binding / conditional pipelines drive
		// the pill color the same way they drive a Rect's fill. `bg` is an
		// explicit override when fill needs to differ from the bg color.
		const bgColor = (this.fill as string) || this.bg || BADGE_DEFAULTS.bg;
		const radius = Math.max(0, Math.min(this.radius ?? h / 2, h / 2));
		ctx.fillStyle = bgColor;
		ctx.beginPath();
		if (
			radius > 0 &&
			'roundRect' in ctx &&
			typeof (ctx as CanvasRenderingContext2D & { roundRect?: unknown }).roundRect === 'function'
		) {
			ctx.roundRect(x, y, w, h, radius);
		} else {
			ctx.rect(x, y, w, h);
		}
		ctx.fill();

		// Icon + label layout
		const innerHeight = Math.max(this.fontSize, iconSize);
		const labelTop = y + padding + innerHeight / 2;
		let cursor = x + padding;

		if (iconRendered && this.iconPosition === 'left' && this._iconEl) {
			const iconY = y + padding + (innerHeight - iconSize) / 2;
			ctx.drawImage(this._iconEl, cursor, iconY, iconSize, iconSize);
			cursor += iconSize + ICON_GAP;
		}

		if (this.label) {
			ctx.font = `${this.fontWeight} ${this.fontSize}px ${this.fontFamily}`;
			ctx.fillStyle = this.fg || BADGE_DEFAULTS.fg;
			ctx.textBaseline = 'middle';
			ctx.textAlign = 'left';
			ctx.fillText(this.label, cursor, labelTop);
			const labelWidth = ctx.measureText(this.label).width;
			cursor += labelWidth;
		}

		if (iconRendered && this.iconPosition === 'right' && this._iconEl) {
			const iconY = y + padding + (innerHeight - iconSize) / 2;
			ctx.drawImage(this._iconEl, cursor + ICON_GAP, iconY, iconSize, iconSize);
		}
	}

	toObject<T = AnyOptions, K extends keyof T = never>(propertiesToInclude?: K[]): Pick<T, K> {
		const extra = [
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
		];
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		return super.toObject([...(propertiesToInclude ?? []), ...extra] as any) as Pick<T, K>;
	}
}

classRegistry.setClass(Badge);
