import { opal, orHttpError } from '#lib/api.js';
import { LIST_PAGE_SIZE, oneOf, pageCursor } from '#lib/components/purchasing/types.js';
import { SUPPLIER_SORT_KEYS } from '@opal/shared';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ url, fetch }) => {
	const p = url.searchParams;
	const page = Math.max(1, Number(p.get('page')) || 1);
	const active = p.get('active');
	const list = await orHttpError(
		opal.using(fetch).purchasing.suppliers.list({
			q: p.get('q') || undefined,
			active: active === 'true' ? true : active === 'false' ? false : undefined,
			sort: oneOf(SUPPLIER_SORT_KEYS, p.get('sort')),
			dir: p.get('dir') === 'desc' ? 'desc' : 'asc',
			cursor: pageCursor(page),
			limit: LIST_PAGE_SIZE
		})
	);
	return { ...list, page };
};
