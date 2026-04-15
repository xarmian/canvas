/** Supported output image formats */
export type OutputFormat = 'png' | 'jpeg' | 'webp';

/** Options for rendering a canvas template */
export interface RenderOptions {
	/** Output format (default: 'png') */
	format?: OutputFormat;
	/** JPEG/WebP quality 1-100 (default: 85) */
	quality?: number;
}

/** A parameter binding on a layer property */
export interface ParamBinding {
	/** URL parameter name */
	param: string;
	/** Default value if parameter is not provided */
	default?: string;
}

/** Parameter bindings map: property name → binding config */
export type ParamBindings = Record<string, ParamBinding>;

/**
 * Fabric.js serialized object (simplified type for our renderer).
 * The full Fabric.js JSON is richer, but we only need these fields for rendering.
 */
export interface FabricObject {
	type: string;
	left?: number;
	top?: number;
	width?: number;
	height?: number;
	scaleX?: number;
	scaleY?: number;
	angle?: number;
	opacity?: number;
	originX?: string;
	originY?: string;
	// Text properties
	text?: string;
	fontSize?: number;
	fontFamily?: string;
	fontWeight?: string | number;
	fontStyle?: string;
	fill?: string;
	textAlign?: string;
	lineHeight?: number;
	// Image properties
	src?: string;
	crossOrigin?: string;
	// Our custom properties for parameter binding
	paramBindings?: ParamBindings;
}

/** Fabric.js serialized canvas JSON */
export interface FabricCanvasJson {
	version?: string;
	objects: FabricObject[];
	background?: string;
	width?: number;
	height?: number;
}

/** Template definition as stored in the database */
export interface CanvasTemplate {
	width: number;
	height: number;
	backgroundType: 'color' | 'image';
	backgroundValue: string;
	templateJson: FabricCanvasJson;
}
