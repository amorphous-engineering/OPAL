import { opal } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const q = url.searchParams.get('q') ?? '';
	const status = url.searchParams.get('status') ?? 'active';
	const workcenters = await opal
		.using(fetch)
		.org.workcenters.list({ activeOnly: false, search: q || undefined });
	return { workcenters, q, status };
};
