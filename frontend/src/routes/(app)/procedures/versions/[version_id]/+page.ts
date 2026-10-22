import { error } from '@sveltejs/kit';
import { api, ApiError } from '#lib/api.js';
import type { VersionDetail, VersionRow } from '#lib/components/procedures/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, fetch }) => {
	const c = api.using(fetch);
	try {
		const version = await c.get<VersionDetail>(`/procedures/versions/${params.version_id}`);
		const [versions, procedure] = await Promise.all([
			c.get<VersionRow[]>(`/procedures/${version.procedure_id}/versions`),
			c.get<{ status: string }>(`/procedures/${version.procedure_id}`)
		]);
		return { version, versions, procedureStatus: procedure.status };
	} catch (e) {
		if (e instanceof ApiError) error(e.status, e.message);
		throw e;
	}
};
