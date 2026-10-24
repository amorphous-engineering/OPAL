import { opal, orHttpError } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, fetch, depends }) => {
	depends('app:purchase');
	const client = opal.using(fetch);
	const id = Number(params.id);
	const [purchase, expenses, received, attachments, suppliers, locations] = await orHttpError(
		Promise.all([
			client.purchasing.orders.get({ id }),
			client.purchasing.orders.expenses({ id }),
			client.purchasing.orders.received({ id }),
			client.platform.attachments.list({ ownerType: 'purchase', ownerId: id }),
			client.purchasing.suppliers.list({ active: true, limit: 500 }),
			client.inventory.locations({}).catch(() => [])
		])
	);
	return {
		purchase,
		expenses,
		received,
		attachments,
		suppliers: suppliers.items,
		locations: locations.map((l) => l.location)
	};
};
