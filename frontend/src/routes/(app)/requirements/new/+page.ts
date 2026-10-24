import { opal, orHttpError } from '#lib/api.js';
import { formProjectId } from '#lib/components/projects/projects.js'; // added by projects
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const client = opal.using(fetch);
	const [tree, assignees] = await orHttpError(
		Promise.all([client.requirements.tree({}), client.org.users.directory({})])
	);
	const parent = url.searchParams.get('parent');
	const parentItem = tree.items.find((i) => String(i.id) === parent); // added by projects
	return {
		projectId: parentItem?.projectId ?? formProjectId(url), // added by projects
		parents: tree.items.filter((i) => i.lifecycleState !== 'cancelled'),
		assignees,
		parentId: parent ? Number(parent) : null
	};
};
