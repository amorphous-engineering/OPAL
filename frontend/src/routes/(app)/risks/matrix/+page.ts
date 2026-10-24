import { opal, orHttpError } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => ({
	matrix: await orHttpError(opal.using(fetch).risks.matrix({}))
});
