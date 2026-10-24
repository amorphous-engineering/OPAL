import { opal } from '#lib/api.js';
import { NOTIFICATION_CATEGORIES, NOTIFICATION_SORTS, NOTIFICATION_STATES } from '@opal/shared';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ url, fetch, depends }) => {
	depends('app:notifications');
	const q = url.searchParams;
	return opal.using(fetch).platform.notifications.list({
		state: NOTIFICATION_STATES.find((s) => s === q.get('state')),
		category: NOTIFICATION_CATEGORIES.find((c) => c === q.get('category')),
		sort: NOTIFICATION_SORTS.find((s) => s === q.get('sort')) ?? 'recent',
		limit: 200
	});
};
