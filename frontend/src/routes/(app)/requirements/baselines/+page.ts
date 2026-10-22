import { api } from '#lib/api.js';
import type { EventSummary } from '#lib/components/requirements/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => ({
	events: await api.using(fetch).get<EventSummary[]>('/requirements/baselines')
});
