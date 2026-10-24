import { opal } from '#lib/api.js';
import { formProjectId } from '#lib/components/projects/projects.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const res = await opal.using(fetch).procedures.list({ limit: 500, sort: 'name', dir: 'asc' });
	// Only a published, live procedure can be cut.
	const procedures = res.items.filter(
		(p) => p.currentVersionId !== null && p.status !== 'obsolete'
	);
	// Context pre-fill from the invoking page (template or published version).
	const wanted = Number(url.searchParams.get('procedure_id') ?? url.searchParams.get('procedure'));
	const version = Number(url.searchParams.get('version_id')) || null;
	const preselect = procedures.some((p) => p.id === wanted) ? wanted : null;
	return {
		procedures,
		preselect,
		preselectVersion: preselect ? version : null,
		projectId: formProjectId(url)
	};
};
