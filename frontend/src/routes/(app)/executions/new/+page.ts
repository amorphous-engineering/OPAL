import { api, type Page } from '#lib/api.js';
import type { PageLoad } from './$types';

interface ProcedureOption {
	id: number;
	name: string;
	procedure_type: string;
	current_version_id: number | null;
}

export const load: PageLoad = async ({ fetch, url }) => {
	const res = await api.using(fetch).get<Page<ProcedureOption>>('/procedures', { page_size: 100 });
	// Only a published procedure can be cut.
	const procedures = res.items
		.filter((p) => p.current_version_id !== null)
		.sort((a, b) => a.name.localeCompare(b.name));
	const wanted = Number(url.searchParams.get('procedure'));
	return { procedures, preselect: procedures.some((p) => p.id === wanted) ? wanted : null };
};
