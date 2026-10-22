import { api, type Page } from '#lib/api.js';
import type { Owner, Risk } from '#lib/components/risks/types.js';
import type { PageLoad } from './$types';

const PAGE_SIZE = 50;

export const load: PageLoad = async ({ fetch, url }) => {
	const p = url.searchParams;
	const query = {
		search: p.get('q'),
		disposition: p.get('disposition'),
		severity: p.get('severity'),
		owner_id: p.get('owner_id'),
		probability: p.get('probability'),
		impact: p.get('impact'),
		residual_probability: p.get('residual_probability'),
		residual_impact: p.get('residual_impact'),
		active: p.get('active'),
		sort: p.get('sort') ?? 'score',
		dir: p.get('dir') ?? 'desc',
		page: p.get('page') ?? '1'
	};
	const http = api.using(fetch);
	try {
		const [list, options] = await Promise.all([
			http.get<Page<Risk>>('/risks', { ...query, page_size: PAGE_SIZE }),
			http.get<{ owners: Owner[] }>('/risks/options')
		]);
		return { list, owners: options.owners, query, error: null };
	} catch (e) {
		return {
			list: { items: [], total: 0 } as Page<Risk>,
			owners: [] as Owner[],
			query,
			error: e instanceof Error ? e.message : 'Failed to load risks'
		};
	}
};
