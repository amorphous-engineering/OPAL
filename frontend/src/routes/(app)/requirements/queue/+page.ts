import { api } from '#lib/api.js';
import type { QueueItem } from '#lib/components/requirements/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => {
	const queue = await api
		.using(fetch)
		.get<{ count: number; ids: number[]; items: QueueItem[] }>('/requirements/queue');
	return { items: queue.items };
};
