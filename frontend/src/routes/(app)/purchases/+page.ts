import { opal, orHttpError } from '#lib/api.js';
import { LIST_PAGE_SIZE, oneOf, pageCursor } from '#lib/components/purchasing/types.js';
import { PURCHASE_SORT_KEYS, PURCHASE_STATUSES } from '@opal/shared';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ url, fetch }) => {
	const p = url.searchParams;
	const status = p.get('status') ?? '';
	const page = Math.max(1, Number(p.get('page')) || 1);
	const client = opal.using(fetch);
	const [list, suppliers] = await orHttpError(
		Promise.all([
			client.purchasing.orders.list({
				status: oneOf(PURCHASE_STATUSES, status),
				open: status === 'open' ? true : undefined,
				awaiting: status === 'awaiting' ? true : undefined,
				overdue: p.get('overdue') ? true : undefined,
				supplierId: Number(p.get('supplier_id')) || undefined,
				q: p.get('q') || undefined,
				targetFrom: p.get('target_from') || undefined,
				targetTo: p.get('target_to') || undefined,
				sort: oneOf(PURCHASE_SORT_KEYS, p.get('sort')) ?? 'createdAt',
				dir: p.get('dir') === 'asc' ? 'asc' : 'desc',
				cursor: pageCursor(page),
				limit: LIST_PAGE_SIZE
			}),
			client.purchasing.suppliers.list({ limit: 500 })
		])
	);
	return { ...list, page, suppliers: suppliers.items };
};
