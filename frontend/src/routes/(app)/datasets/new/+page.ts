import { api, type Page } from '#lib/api.js';
import type { ProcedureOption } from '#lib/components/datasets/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const procedures = await api
		.using(fetch)
		.get<Page<ProcedureOption>>('/procedures', { page_size: 100 });
	// Context pre-fill: a link from a procedure passes ?procedure=<id>.
	return { procedures: procedures.items, procedure: url.searchParams.get('procedure') ?? '' };
};
