import { api, type Page } from '#lib/api.js';
import type { PickedPart, Supplier } from '#lib/components/purchasing/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ url, fetch }) => {
	const http = api.using(fetch);
	const partId = url.searchParams.get('part_id');
	const [suppliers, locations, part] = await Promise.all([
		http.get<Page<Supplier>>('/suppliers', { per_page: 100, is_active: true }),
		http.get<{ location: string }[]>('/inventory/locations'),
		// Context pre-fill: arriving from a part, that part is already the first line.
		partId ? http.get<PickedPart>(`/parts/${partId}`).catch(() => null) : Promise.resolve(null)
	]);
	// Context pre-fill: from a part, its preferred supplier (or its only one) is the order's supplier.
	let supplierId = url.searchParams.get('supplier_id');
	if (!supplierId && part) {
		const linked = await http
			.get<{ supplier_id: number; is_preferred: boolean }[]>(`/parts/${part.id}/suppliers`)
			.catch(() => []);
		const pick = linked.find((l) => l.is_preferred) ?? (linked.length === 1 ? linked[0] : null);
		if (pick) supplierId = String(pick.supplier_id);
	}
	return {
		suppliers: suppliers.items,
		locations: locations.map((l) => l.location),
		supplierId,
		part
	};
};
