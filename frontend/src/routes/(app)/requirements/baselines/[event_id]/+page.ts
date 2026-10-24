import { opal, orHttpError } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => ({
	event: await orHttpError(opal.using(fetch).requirements.baselineEvent({ id: Number(params.event_id) }))
});
