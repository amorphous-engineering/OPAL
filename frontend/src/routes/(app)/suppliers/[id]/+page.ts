import { opal, orHttpError } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, fetch }) => {
	const client = opal.using(fetch);
	const id = Number(params.id);
	const [supplier, parts, purchases] = await orHttpError(
		Promise.all([
			client.purchasing.suppliers.get({ id }),
			client.purchasing.catalog.list({ id }),
			client.purchasing.orders.list({ supplierId: id, limit: 200 })
		])
	);
	return { supplier, parts, purchases: purchases.items };
};
