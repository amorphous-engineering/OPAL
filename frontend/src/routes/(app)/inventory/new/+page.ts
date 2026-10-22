import { api, ApiError } from '#lib/api.js';
import type { LocationSummary, PickedPart, TierRule } from '#lib/components/inventory/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const client = api.using(fetch);
	const partId = Number(url.searchParams.get('part_id')) || null;

	const [locations, tiers, part] = await Promise.all([
		client.get<LocationSummary[]>('/inventory/locations').catch(() => [] as LocationSummary[]),
		client
			.get<{ tiers: TierRule[] }>('/project/config')
			.then((c) => c.tiers)
			.catch(() => [] as TierRule[]),
		partId
			? client.get<PickedPart>(`/parts/${partId}`).catch((e) => {
					if (e instanceof ApiError && e.status === 404) return null;
					throw e;
				})
			: Promise.resolve(null)
	]);

	return { locations: locations.map((l) => l.location).filter(Boolean), tiers, part };
};
