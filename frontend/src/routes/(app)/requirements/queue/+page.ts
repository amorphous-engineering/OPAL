import { opal, orHttpError } from '#lib/api.js';
import { redirect } from '@sveltejs/kit'; // added by projects
import { filterProjectId } from '#lib/components/projects/projects.js'; // added by projects
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	// added by projects: a baseline event covers one project, so the queue is one project's.
	const projectId = filterProjectId(url);
	const queue = await orHttpError(opal.using(fetch).requirements.queue({ projectId }));
	const first = queue.items[0]?.projectId;
	if (!projectId && first && queue.items.some((i) => i.projectId !== first)) {
		redirect(307, `/requirements/queue?project=${first}`);
	}
	return { items: queue.items, projectId };
};
