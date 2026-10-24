import { ApiError, opal } from '#lib/api.js';
import type { StockDetail } from '@opal/shared';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params, url }) => {
	const client = opal.using(fetch);
	try {
		const [detail, locations, labels] = await Promise.all([
			client.inventory.detail({ opalNumber: params.opal_number }),
			client.inventory.locations({}),
			client.inventory.labels({ inventory: params.opal_number, origin: url.origin })
		]);
		return {
			opal: params.opal_number,
			detail,
			locations: locations.map((l) => l.location),
			qrSvg: labels.labels[0]?.qrSvg ?? null,
			error: null as string | null
		};
	} catch (e) {
		return {
			opal: params.opal_number,
			detail: null as StockDetail | null,
			locations: [] as string[],
			qrSvg: null as string | null,
			error: e instanceof ApiError || e instanceof Error ? e.message : 'Could not load record'
		};
	}
};
