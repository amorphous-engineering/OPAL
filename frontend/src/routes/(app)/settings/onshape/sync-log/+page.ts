import { api } from '#lib/api.js';
import type { SyncLog } from '#lib/components/settings/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ url, fetch }) => {
	const direction = url.searchParams.get('direction') ?? '';
	const logs = await api
		.using(fetch)
		.get<SyncLog[]>('/onshape/sync/logs', { limit: 100, direction });
	return { logs, direction };
};
