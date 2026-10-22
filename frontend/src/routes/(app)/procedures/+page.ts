import { api, type Page } from '#lib/api.js';
import type { ProcedureRow } from '#lib/components/procedures/types.js';
import type { PageLoad } from './$types';

// URL sort keys are column keys; the API names a few of them differently.
const API_SORT: Record<string, string> = {
	name: 'name',
	procedure_type: 'type',
	status: 'status',
	current_version_number: 'version',
	step_count: 'steps',
	execution_count: 'executions',
	updated_at: 'updated_at',
	created_at: 'created_at'
};

export const load: PageLoad = async ({ url, fetch }) => {
	const q = url.searchParams;
	const result = await api.using(fetch).get<Page<ProcedureRow>>('/procedures', {
		search: q.get('q'),
		status: q.get('status'),
		procedure_type: q.get('type'),
		sort: API_SORT[q.get('sort') ?? ''] ?? 'updated_at',
		dir: q.get('dir') === 'asc' ? 'asc' : 'desc',
		page: q.get('page') ?? 1,
		page_size: 50
	});
	return { result };
};
