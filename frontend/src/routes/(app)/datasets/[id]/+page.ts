import { api, type Page } from '#lib/api.js';
import type { DatasetDetail, ProcedureOption } from '#lib/components/datasets/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => {
	const a = api.using(fetch);
	const [dataset, procedures] = await Promise.all([
		a.get<DatasetDetail>(`/datasets/${params.id}`, { limit_points: 1000 }),
		a.get<Page<ProcedureOption>>('/procedures', { page_size: 100 })
	]);
	return { dataset, procedures: procedures.items };
};
