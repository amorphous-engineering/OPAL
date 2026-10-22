import { error } from '@sveltejs/kit';
import { api, ApiError } from '#lib/api.js';
import type { EventDetail } from '#lib/components/requirements/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => {
	try {
		return {
			event: await api.using(fetch).get<EventDetail>(`/requirements/baselines/${params.event_id}`)
		};
	} catch (e) {
		if (e instanceof ApiError) error(e.status, e.message);
		throw e;
	}
};
