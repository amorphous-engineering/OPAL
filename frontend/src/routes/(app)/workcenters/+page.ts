import { api } from '#lib/api.js';
import type { Workcenter } from '#lib/components/workcenters/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const q = url.searchParams.get('q') ?? '';
	const status = url.searchParams.get('status') ?? 'active';
	const workcenters = await api
		.using(fetch)
		.get<Workcenter[]>('/workcenters', { active_only: false, search: q });
	return { workcenters, q, status };
};
