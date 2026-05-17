export { render } from './renderer.js';
export { wrapText, fitText, drawWrappedText } from './text.js';
export { loadRemoteImage, loadImageFromBuffer, loadImagesParallel } from './images.js';
export {
	initDefaultFonts,
	registerFontFromBuffer,
	registerFontFromPath,
	getRegisteredFonts
} from './fonts.js';
export type {
	CanvasTemplate,
	FabricCanvasJson,
	FabricObject,
	RenderOptions,
	OutputFormat,
	ParamBinding,
	ParamBindings
} from './types.js';
