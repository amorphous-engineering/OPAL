import { opal, orHttpError } from '#lib/api.js';
import { filterProjectId, projectOptions } from '#lib/components/projects/projects.js'; // added by projects
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const client = opal.using(fetch);
	const [events, projects] = await orHttpError(
		Promise.all([
			client.requirements.baselines({ projectId: filterProjectId(url) }),
			projectOptions(client)
		]) // added by projects
	);
	return { events, projects };
};
