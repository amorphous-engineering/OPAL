import { opal, orHttpError } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, fetch }) => ({
	plugin: await orHttpError(opal.using(fetch).plugins.get({ id: params.id }))
});
