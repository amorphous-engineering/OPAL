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
	// Context pre-fill from the invoking page (template or published version).
	const wanted = Number(url.searchParams.get('procedure_id') ?? url.searchParams.get('procedure'));
	const version = Number(url.searchParams.get('version_id')) || null;
	const preselect = procedures.some((p) => p.id === wanted) ? wanted : null;
	return { procedures, preselect, preselectVersion: preselect ? version : null };
};
