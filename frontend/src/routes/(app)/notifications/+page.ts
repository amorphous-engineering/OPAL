import { api } from '#lib/api.js';
import type { Notification } from '#lib/components/shell/notifications.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ url, fetch, depends }) => {
	depends('app:notifications');
	const q = url.searchParams;
	const list = await api.using(fetch).get<{
		items: Notification[];
		unread_count: number;
		total: number;
	}>('/notifications', {
		state: q.get('state'),
		category: q.get('category'),
		sort: q.get('sort'),
		limit: 200
	});
	return list;
};
