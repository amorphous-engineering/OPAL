import { api, ApiError } from '#lib/api.js';
import type { LocationSummary, OpalDetail } from '#lib/components/inventory/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => {
	const client = api.using(fetch);
	try {
		const [detail, locations] = await Promise.all([
			client.get<OpalDetail>(`/inventory/opal/${encodeURIComponent(params.opal_number)}/detail`),
			client.get<LocationSummary[]>('/inventory/locations').catch(() => [] as LocationSummary[])
		]);
		return {
			opal: params.opal_number,
			detail,
			locations: locations.map((l) => l.location).filter(Boolean),
			error: null as string | null
		};
	} catch (e) {
		return {
			opal: params.opal_number,
			detail: null,
			locations: [] as string[],
			error: e instanceof ApiError || e instanceof Error ? e.message : 'Could not load record'
		};
	}
};
