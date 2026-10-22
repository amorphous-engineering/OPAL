import { api, type Page } from '#lib/api.js';
import {
	LIST_PAGE_SIZE,
	type PurchaseListItem,
	type Supplier
} from '#lib/components/purchasing/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ url, fetch }) => {
	const p = url.searchParams;
	const status = p.get('status') ?? '';
	const page = Math.max(1, Number(p.get('page')) || 1);
	const http = api.using(fetch);
	const [list, suppliers] = await Promise.all([
		http.get<{ items: PurchaseListItem[]; total: number }>('/purchases', {
			status: status && status !== 'open' && status !== 'awaiting' ? status : undefined,
			open: status === 'open' ? true : undefined,
			awaiting: status === 'awaiting' ? true : undefined,
			overdue: p.get('overdue') ? true : undefined,
			supplier_id: p.get('supplier_id') || undefined,
			q: p.get('q') || undefined,
			target_from: p.get('target_from') || undefined,
			target_to: p.get('target_to') || undefined,
			sort: p.get('sort') || undefined,
			dir: p.get('dir') || undefined,
			skip: (page - 1) * LIST_PAGE_SIZE,
			limit: LIST_PAGE_SIZE
		}),
		http.get<Page<Supplier>>('/suppliers', { per_page: 100 })
	]);
	return { ...list, page, suppliers: suppliers.items };
};
