import { error } from '@sveltejs/kit';
import { api, ApiError } from '#lib/api.js';
import type { VersionDiff } from '#lib/components/procedures/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, fetch }) => {
	try {
		const diff = await api
			.using(fetch)
			.get<VersionDiff>(`/procedures/${params.id}/versions/${params.v1}/diff/${params.v2}`);
		return { diff };
	} catch (e) {
		if (e instanceof ApiError) error(e.status, e.message);
		throw e;
	}
};
