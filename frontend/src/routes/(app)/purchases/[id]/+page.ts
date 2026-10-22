import { error } from '@sveltejs/kit';
import { api, ApiError, type Page } from '#lib/api.js';
import type {
	Attachment,
	Expense,
	Purchase,
	ReceivedRecord,
	Supplier
} from '#lib/components/purchasing/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, fetch, depends }) => {
	depends('app:purchase');
	const http = api.using(fetch);
	try {
		const purchase = await http.get<Purchase>(`/purchases/${params.id}`);
		const [expenses, received, attachments, suppliers, locations] = await Promise.all([
			http.get<Expense[]>(`/purchases/${params.id}/expenses`),
			http.get<ReceivedRecord[]>(`/purchases/${params.id}/inventory`),
			http.get<Attachment[]>('/attachments', { purchase_id: params.id }),
			http.get<Page<Supplier>>('/suppliers', { per_page: 100, is_active: true }),
			http.get<{ location: string }[]>('/inventory/locations')
		]);
		return {
			purchase,
			expenses,
			received,
			attachments,
			suppliers: suppliers.items,
			locations: locations.map((l) => l.location)
		};
	} catch (e) {
		if (e instanceof ApiError) error(e.status, e.message);
		throw e;
	}
};
