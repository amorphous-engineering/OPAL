import { error } from '@sveltejs/kit';
import { api, ApiError } from '#lib/api.js';
import type { VersionDetail } from '#lib/components/procedures/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, fetch }) => {
	try {
		const version = await api.using(fetch).get<VersionDetail>(`/procedures/versions/${params.vid}`);
		if (String(version.procedure_id) !== params.id) error(404, 'Version not found');
		return { version };
	} catch (e) {
		if (e instanceof ApiError) error(e.status, e.message);
		throw e;
	}
};
