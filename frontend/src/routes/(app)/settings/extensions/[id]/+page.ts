import { error } from '@sveltejs/kit';
import { api, ApiError } from '#lib/api.js';
import type { ExtensionDetail } from '#lib/components/settings/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, fetch }) => {
	try {
		return { ext: await api.using(fetch).get<ExtensionDetail>(`/extensions/${params.id}`) };
	} catch (e) {
		if (e instanceof ApiError && e.status === 404) error(404, 'No such extension');
		throw e;
	}
};
