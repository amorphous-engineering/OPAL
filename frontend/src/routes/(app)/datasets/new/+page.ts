import { procedureOptions } from '#lib/components/datasets/procedures.js';
import { formProjectId } from '#lib/components/projects/projects.js'; // added by projects
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	// Context pre-fill: a link from a procedure passes ?procedure=<id>.
	return { procedures: await procedureOptions(fetch), procedure: url.searchParams.get('procedure') ?? '', projectId: formProjectId(url) };
};
