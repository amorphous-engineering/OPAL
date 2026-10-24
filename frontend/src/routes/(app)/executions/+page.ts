import { api, type Page } from '#lib/api.js';
import type { Overview } from '#lib/execution/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const q = url.searchParams;
	const status = q.get('status') ?? 'active';
	const client = api.using(fetch);
	const [overview, procedures] = await Promise.all([
		client.get<Overview>('/procedure-instances/overview', {
			status: status === 'active' ? ['cut', 'in_work'] : status === 'all' ? undefined : status,
			procedure_id: q.get('procedure'),
			q: q.get('q'),
			mine: q.get('mine') === '1' ? true : undefined,
			held: q.get('held') === '1' ? true : undefined,
			sort: q.get('sort') ?? 'created',
			dir: q.get('dir') ?? 'desc',
			page: q.get('page') ?? 1,
			page_size: 50
		}),
		client.get<Page<{ id: number; template_number: string; name: string }>>('/procedures', {
			page_size: 100
		})
	]);
	return { overview, procedures: procedures.items };
};
