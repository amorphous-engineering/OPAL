import { api, type Page } from '#lib/api.js';
import type { ProcedureRow } from '#lib/components/procedures/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ url, fetch }) => {
	const q = url.searchParams;
	const result = await api.using(fetch).get<Page<ProcedureRow>>('/procedures', {
		search: q.get('q'),
		status: q.get('status'),
		procedure_type: q.get('type'),
		sort: q.get('sort') ?? 'updated_at',
		dir: q.get('dir') ?? 'desc',
		page: q.get('page') ?? 1,
		page_size: 50
	});
	return { result };
};
