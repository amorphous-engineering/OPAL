import { api } from '#lib/api.js';
import {
	PARTS_PAGE_SIZE as PAGE_SIZE,
	type Part,
	type PartSchema,
	type PartsQuery
} from '#lib/components/parts/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ url, fetch }) => {
	const p = url.searchParams;
	const query: PartsQuery = {
		q: p.get('q') ?? '',
		tier: p.get('tier') ?? '',
		category: p.get('category') ?? '',
		procurement: p.get('procurement') ?? '',
		state: p.get('state') ?? '',
		parent: p.get('parent') ?? '',
		low: p.get('low') === '1',
		tooling: p.get('tooling') ?? '',
		sort: p.get('sort') ?? 'internal_pn',
		dir: p.has('sort') ? (p.get('dir') === 'desc' ? 'desc' : 'asc') : 'asc',
		page: Math.max(1, Number(p.get('page') ?? 1) || 1)
	};
	const client = api.using(fetch);
	const [list, schema] = await Promise.all([
		client.get<{ items: Part[]; total: number }>('/parts', {
			search: query.q,
			tier: query.tier,
			category: query.category,
			procurement: query.procurement,
			state: query.state,
			has_parent: query.parent === 'sub' ? true : query.parent === 'top' ? false : undefined,
			low_stock: query.low || undefined,
			tooling: query.tooling === 'yes' ? true : query.tooling === 'no' ? false : undefined,
			sort_by: query.sort,
			sort_order: query.dir,
			skip: (query.page - 1) * PAGE_SIZE,
			limit: PAGE_SIZE
		}),
		client.get<PartSchema>('/parts/schema')
	]);
	return { query, list, schema };
};
