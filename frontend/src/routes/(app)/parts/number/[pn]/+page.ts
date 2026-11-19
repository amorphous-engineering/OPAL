import { redirect } from '@sveltejs/kit';
import { opal, orHttpError } from '#lib/api.js';
import type { PageLoad } from './$types';

// A part addressed by its number, as step text links it: the number is what a person wrote, and
// it names one part for good. The part page itself is addressed by row id.
export const load: PageLoad = async ({ params, fetch }) => {
	const part = await orHttpError(opal.using(fetch).parts.byNumber({ internalPn: params.pn }));
	redirect(307, `/parts/${part.id}`);
};
