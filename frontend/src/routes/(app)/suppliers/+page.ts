import { api } from '#lib/api.js';
import { LIST_PAGE_SIZE, type Supplier } from '#lib/components/purchasing/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ url, fetch }) => {
	const p = url.searchParams;
	const page = Math.max(1, Number(p.get('page')) || 1);
	const active = p.get('active');
	const list = await api.using(fetch).get<{ items: Supplier[]; total: number }>('/suppliers', {
		search: p.get('q') || undefined,
		is_active: active === 'true' ? true : active === 'false' ? false : undefined,
		sort: p.get('sort') || undefined,
		dir: p.get('dir') || undefined,
		page,
		per_page: LIST_PAGE_SIZE
	});
	return { ...list, page };
};
