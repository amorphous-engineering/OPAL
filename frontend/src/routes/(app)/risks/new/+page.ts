import { api } from '#lib/api.js';
import type { Owner } from '#lib/components/risks/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const http = api.using(fetch);
	const owners = await http.get<Owner[]>('/users/directory');
	// Context pre-fill: /risks/new?asset_part_id=12 (from a part page) names the asset already.
	let asset: { id: number; label: string } | null = null;
	const partId = url.searchParams.get('asset_part_id');
	if (partId) {
		try {
			const p = await http.get<{ id: number; internal_pn: string | null; name: string }>(
				`/parts/${partId}`
			);
			asset = { id: p.id, label: p.internal_pn ? `${p.internal_pn} ${p.name}` : p.name };
		} catch {
			/* unknown part: start with no asset */
		}
	}
	return { owners, asset };
};
