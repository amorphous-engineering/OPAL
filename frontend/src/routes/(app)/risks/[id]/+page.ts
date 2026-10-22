import { error } from '@sveltejs/kit';
import { api, ApiError } from '#lib/api.js';
import type { HistoryRow, Owner, Risk } from '#lib/components/risks/types.js';
import type { PageLoad } from './$types';

export interface Readiness {
	ready: boolean;
	checks: { key: string; label: string; passed: boolean; detail: string | null }[];
}

export const load: PageLoad = async ({ fetch, params }) => {
	const http = api.using(fetch);
	const id = encodeURIComponent(params.id);
	try {
		const [risk, readiness, history, options] = await Promise.all([
			http.get<Risk>(`/risks/${id}`),
			http.get<Readiness>(`/risks/${id}/readiness`),
			http.get<HistoryRow[]>(`/risks/${id}/history`),
			http.get<{ owners: Owner[] }>('/risks/options')
		]);
		return { risk, readiness, history, owners: options.owners };
	} catch (e) {
		if (e instanceof ApiError && (e.status === 404 || e.status === 422))
			error(404, 'Risk not found');
		throw e;
	}
};
