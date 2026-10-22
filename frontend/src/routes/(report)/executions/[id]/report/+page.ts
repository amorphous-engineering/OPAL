import { api, ApiError } from '#lib/api.js';
import type { Report } from '#lib/execution/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => {
	const id = Number(params.id);
	try {
		const report = await api.using(fetch).get<Report>(`/procedure-instances/${id}/report`);
		return { id, report, problem: null as string | null };
	} catch (e) {
		// A work order that is not completed has no report: say why, link back.
		if (e instanceof ApiError && (e.status === 400 || e.status === 404)) {
			return { id, report: null, problem: e.message };
		}
		throw e;
	}
};
