import { ApiError, opal, orHttpError } from '#lib/api.js';
import { toPickedPart } from '#lib/components/parts/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ url, fetch }) => {
	const client = opal.using(fetch);
	const partId = Number(url.searchParams.get('part_id')) || null;
	const [suppliers, locations, part] = await orHttpError(
		Promise.all([
			client.purchasing.suppliers.list({ active: true, limit: 500 }),
			client.inventory.locations({}).catch(() => []),
			// Context pre-fill: arriving from a part, that part is already the first line.
			partId
				? client.parts
						.get({ id: partId })
						.then(toPickedPart)
						.catch((e) => {
							if (e instanceof ApiError && e.status === 404) return null;
							throw e;
						})
				: Promise.resolve(null)
		])
	);
	// Context pre-fill: from a part, its preferred supplier (or its only one) is the order's supplier.
	let supplierId = url.searchParams.get('supplier_id');
	if (!supplierId && part) {
		const linked = await client.purchasing.catalog.forPart({ id: part.id }).catch(() => []);
		const pick = linked.find((l) => l.isPreferred) ?? (linked.length === 1 ? linked[0] : null);
		if (pick) supplierId = String(pick.supplierId);
	}
	return {
		suppliers: suppliers.items,
		locations: locations.map((l) => l.location),
		supplierId,
		part
	};
};
