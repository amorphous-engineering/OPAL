import { opal } from '#lib/api.js';
import { filterProjectId, projectOptions } from '#lib/components/projects/projects.js';
import { EXECUTION_SORT_KEYS } from '@opal/shared';
import type { PageLoad } from './$types';

const PAGE_SIZE = 50;

export const load: PageLoad = async ({ fetch, url }) => {
	const q = url.searchParams;
	const status = q.get('status') ?? 'active';
	const client = opal.using(fetch);
	const page = Math.max(1, Number(q.get('page') ?? 1) || 1);
	const [executions, procedures, projects] = await Promise.all([
		client.execution.list({
			status: status === 'active' ? 'cut,in_work' : status === 'all' ? undefined : status,
			procedureId: Number(q.get('procedure')) || undefined,
			projectId: filterProjectId(url),
			q: q.get('q') || undefined,
			mine: q.get('mine') === '1' ? 'true' : undefined,
			held: q.get('held') === '1' ? 'true' : undefined,
			sort: EXECUTION_SORT_KEYS.find((s) => s === q.get('sort')),
			dir: q.get('dir') === 'asc' ? 'asc' : 'desc',
			// The cursor is the row offset.
			cursor: page > 1 ? String((page - 1) * PAGE_SIZE) : undefined,
			limit: PAGE_SIZE
		}),
		client.procedures.list({ limit: 100 }),
		projectOptions(client)
	]);
	return { executions, procedures: procedures.items, projects };
};
