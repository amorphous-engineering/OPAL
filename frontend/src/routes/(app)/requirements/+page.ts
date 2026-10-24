import { opal, orHttpError } from '#lib/api.js';
import { filterProjectId, projectOptions } from '#lib/components/projects/projects.js'; // added by projects
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const client = opal.using(fetch);
	const c = client.requirements;
	const projectId = filterProjectId(url); // added by projects
	const [tree, summary, catalog, projects] = await orHttpError(
		Promise.all([
			c.tree({ projectId }),
			c.summary({ projectId }),
			c.catalog({}),
			projectOptions(client)
		])
	);
	return { tree, summary, catalog, projects, projectId };
};
