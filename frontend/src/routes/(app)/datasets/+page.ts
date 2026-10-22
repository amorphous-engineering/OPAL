import { api, type Page } from '#lib/api.js';
import type { DatasetSummary, ProcedureOption } from '#lib/components/datasets/types.js';
import type { PageLoad } from './$types';

const PAGE_SIZE = 50;

export const load: PageLoad = async ({ fetch, url }) => {
	const p = url.searchParams;
	const page = Math.max(1, Number(p.get('page')) || 1);
	const a = api.using(fetch);
	const [datasets, procedures] = await Promise.all([
		a.get<Page<DatasetSummary>>('/datasets', {
			search: p.get('q') ?? '',
			procedure_id: p.get('procedure') ?? '',
			page,
			page_size: PAGE_SIZE
		}),
		a.get<Page<ProcedureOption>>('/procedures', { page_size: 100 })
	]);
	return { datasets, procedures: procedures.items };
};
