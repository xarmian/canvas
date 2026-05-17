/**
 * `@canvas-images/sdk` — TypeScript client for the Canvas Render API.
 *
 * The async surface (`bake`, `list`, `get`, `delete`), typed error
 * classes, and rate-limit surfacing land in TASK-220+ under PLAN-216.
 */

export { CanvasClient } from './client.js';
export type {
	CanvasClientConfig,
	ImageParamValue,
	ImageParams
} from './client.js';

/** Package version. Bumped by changesets at release time (TASK-230). */
export const SDK_VERSION = '0.0.0';
