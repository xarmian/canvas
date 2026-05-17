/**
 * `@canvas-images/sdk` — TypeScript client for the Canvas Render API.
 *
 * This module is a scaffold (TASK-218). The actual client surface
 * (`CanvasClient`, `client.image()`, `client.bake()`, error classes,
 * rate-limit surfacing) lands in TASK-219+ under PLAN-216.
 *
 * The single `SDK_VERSION` export below gives tsup something concrete
 * to bundle so the build + `pnpm pack` smoke check have a non-empty
 * artifact to validate the exports map against.
 */

export const SDK_VERSION = '0.0.0';
