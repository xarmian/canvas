import type { PageServerLoad } from './$types';
import { TEMPLATES } from '$lib/templates/gallery';

/**
 * Server-render the gallery so the templates list is visible before
 * client hydration (SEO + first-paint). The full TemplateDefinition
 * including templateJson is small (~5 KB total) so we just pass the
 * whole array — no need to lazy-load templateJson per click.
 */
export const load: PageServerLoad = async () => {
	return { templates: TEMPLATES };
};
