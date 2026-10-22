import { error } from '@sveltejs/kit';
import { api, ApiError } from '#lib/api.js';
import type { PurchaseListItem, Supplier, SupplierPart } from '#lib/components/purchasing/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, fetch }) => {
	const http = api.using(fetch);
	try {
		const [supplier, parts, purchases] = await Promise.all([
			http.get<Supplier>(`/suppliers/${params.id}`),
			http.get<SupplierPart[]>(`/suppliers/${params.id}/parts`),
			http.get<{ items: PurchaseListItem[]; total: number }>('/purchases', {
				supplier_id: params.id,
				limit: 200
			})
		]);
		return { supplier, parts, purchases: purchases.items };
	} catch (e) {
		if (e instanceof ApiError) error(e.status, e.message);
		throw e;
	}
};
