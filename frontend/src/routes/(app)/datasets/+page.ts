import { api, type Page } from '#lib/api.js';
import type { DatasetSummary, ProcedureOption } from '#lib/components/datasets/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const search = url.searchParams.get('search') ?? '';
	const procedure = url.searchParams.get('procedure') ?? '';
	const page = Number(url.searchParams.get('page') ?? '1') || 1;
	const a = api.using(fetch);
	const [datasets, procedures] = await Promise.all([
		a.get<Page<DatasetSummary>>('/datasets', {
			search,
			procedure_id: procedure,
			page,
			page_size: 50
		}),
		a.get<Page<ProcedureOption>>('/procedures', { page_size: 100 })
	]);
	return { datasets, procedures: procedures.items, search, procedure, page };
};
