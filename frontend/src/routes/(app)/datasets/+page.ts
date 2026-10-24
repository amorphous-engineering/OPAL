import { opal, orHttpError } from '#lib/api.js';
import { filterProjectId, projectOptions } from '#lib/components/projects/projects.js'; // added by projects
import { procedureOptions } from '#lib/components/datasets/procedures.js';
import { DATASET_STATES } from '@opal/shared';
import type { PageLoad } from './$types';

const PAGE_SIZE = 50;

export const load: PageLoad = async ({ fetch, url }) => {
	const p = url.searchParams;
	const q = p.get('q') ?? '';
	const state = DATASET_STATES.find((s) => s === p.get('state'));
	const procedure = Number(p.get('procedure')) || undefined;
	// A cursor is only valid for the filters it was issued under; a filter change drops `page`.
	const page = Math.max(1, Number(p.get('page') ?? 1) || 1);
	const cursor = page > 1 ? (p.get('cursor') ?? undefined) : undefined;
	const [list, procedures, projects] = await orHttpError(
		Promise.all([
			opal.using(fetch).datasets.list({
				q: q || undefined,
				projectId: filterProjectId(url), // added by projects
				state,
				procedureId: procedure,
				cursor,
				limit: PAGE_SIZE
			}),
			procedureOptions(fetch),
			projectOptions(opal.using(fetch)) // added by projects
		])
	);
	return { list, procedures, projects, page: cursor ? page : 1 };
};
