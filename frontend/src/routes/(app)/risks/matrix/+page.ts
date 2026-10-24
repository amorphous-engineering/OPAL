import { opal, orHttpError } from '#lib/api.js';
import { filterProjectId, projectOptions } from '#lib/components/projects/projects.js'; // added by projects
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const client = opal.using(fetch);
	const projectId = filterProjectId(url);
	const [matrix, projects] = await orHttpError(
		Promise.all([client.risks.matrix({ projectId }), projectOptions(client)])
	);
	return { matrix, projects, projectId };
};
