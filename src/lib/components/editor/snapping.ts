import type { Canvas, FabricObject } from 'fabric';

const SNAP_THRESHOLD = 5;
const GUIDE_COLOR = '#2563eb';
const GUIDE_WIDTH = 1;

interface GuideLine {
	x1: number;
	y1: number;
	x2: number;
	y2: number;
}

/**
 * Sets up snapping/alignment guides on a Fabric.js canvas.
 * Returns a cleanup function to remove the event listeners.
 */
export function setupSnapping(canvas: Canvas): () => void {
	let guides: GuideLine[] = [];

	function onObjectMoving(e: { target: FabricObject }) {
		const target = e.target;
		if (!target) return;

		const canvasWidth = canvas.getWidth();
		const canvasHeight = canvas.getHeight();
		guides = [];

		// Use bounding rect for rotation-aware bounds
		const objBounds = target.getBoundingRect();
		const objLeft = objBounds.left;
		const objTop = objBounds.top;
		const objWidth = objBounds.width;
		const objHeight = objBounds.height;
		const objCenterX = objLeft + objWidth / 2;
		const objCenterY = objTop + objHeight / 2;
		const objRight = objLeft + objWidth;
		const objBottom = objTop + objHeight;

		// Snap to canvas center
		const canvasCenterX = canvasWidth / 2;
		const canvasCenterY = canvasHeight / 2;

		if (Math.abs(objCenterX - canvasCenterX) < SNAP_THRESHOLD) {
			target.left = canvasCenterX - objWidth / 2;
			guides.push({ x1: canvasCenterX, y1: 0, x2: canvasCenterX, y2: canvasHeight });
		}
		if (Math.abs(objCenterY - canvasCenterY) < SNAP_THRESHOLD) {
			target.top = canvasCenterY - objHeight / 2;
			guides.push({ x1: 0, y1: canvasCenterY, x2: canvasWidth, y2: canvasCenterY });
		}

		// Snap to canvas edges
		if (Math.abs(objLeft) < SNAP_THRESHOLD) {
			target.left = 0;
			guides.push({ x1: 0, y1: 0, x2: 0, y2: canvasHeight });
		}
		if (Math.abs(objTop) < SNAP_THRESHOLD) {
			target.top = 0;
			guides.push({ x1: 0, y1: 0, x2: canvasWidth, y2: 0 });
		}
		if (Math.abs(objRight - canvasWidth) < SNAP_THRESHOLD) {
			target.left = canvasWidth - objWidth;
			guides.push({ x1: canvasWidth, y1: 0, x2: canvasWidth, y2: canvasHeight });
		}
		if (Math.abs(objBottom - canvasHeight) < SNAP_THRESHOLD) {
			target.top = canvasHeight - objHeight;
			guides.push({ x1: 0, y1: canvasHeight, x2: canvasWidth, y2: canvasHeight });
		}

		// Snap to other objects
		const objects = canvas.getObjects().filter((o) => o !== target);
		for (const other of objects) {
			if (!other.visible) continue;

			const oBounds = other.getBoundingRect();
			const oLeft = oBounds.left;
			const oTop = oBounds.top;
			const oWidth = oBounds.width;
			const oHeight = oBounds.height;
			const oCenterX = oLeft + oWidth / 2;
			const oCenterY = oTop + oHeight / 2;
			const oRight = oLeft + oWidth;
			const oBottom = oTop + oHeight;

			// Vertical alignment (left/center/right edges)
			if (Math.abs(objLeft - oLeft) < SNAP_THRESHOLD) {
				target.left = oLeft;
				guides.push({ x1: oLeft, y1: 0, x2: oLeft, y2: canvasHeight });
			} else if (Math.abs(objCenterX - oCenterX) < SNAP_THRESHOLD) {
				target.left = oCenterX - objWidth / 2;
				guides.push({ x1: oCenterX, y1: 0, x2: oCenterX, y2: canvasHeight });
			} else if (Math.abs(objRight - oRight) < SNAP_THRESHOLD) {
				target.left = oRight - objWidth;
				guides.push({ x1: oRight, y1: 0, x2: oRight, y2: canvasHeight });
			}

			// Horizontal alignment (top/center/bottom edges)
			if (Math.abs(objTop - oTop) < SNAP_THRESHOLD) {
				target.top = oTop;
				guides.push({ x1: 0, y1: oTop, x2: canvasWidth, y2: oTop });
			} else if (Math.abs(objCenterY - oCenterY) < SNAP_THRESHOLD) {
				target.top = oCenterY - objHeight / 2;
				guides.push({ x1: 0, y1: oCenterY, x2: canvasWidth, y2: oCenterY });
			} else if (Math.abs(objBottom - oBottom) < SNAP_THRESHOLD) {
				target.top = oBottom - objHeight;
				guides.push({ x1: 0, y1: oBottom, x2: canvasWidth, y2: oBottom });
			}
		}

		canvas.requestRenderAll();
	}

	function onAfterRender(ctx: { ctx: CanvasRenderingContext2D }) {
		if (guides.length === 0) return;

		const renderCtx = ctx.ctx;
		renderCtx.save();
		renderCtx.strokeStyle = GUIDE_COLOR;
		renderCtx.lineWidth = GUIDE_WIDTH;
		renderCtx.setLineDash([4, 4]);

		for (const guide of guides) {
			renderCtx.beginPath();
			renderCtx.moveTo(guide.x1, guide.y1);
			renderCtx.lineTo(guide.x2, guide.y2);
			renderCtx.stroke();
		}

		renderCtx.restore();
	}

	function onMouseUp() {
		guides = [];
		canvas.requestRenderAll();
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	canvas.on('object:moving', onObjectMoving as any);
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	canvas.on('after:render', onAfterRender as any);
	canvas.on('mouse:up', onMouseUp);

	return () => {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		canvas.off('object:moving', onObjectMoving as any);
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		canvas.off('after:render', onAfterRender as any);
		canvas.off('mouse:up', onMouseUp);
	};
}
