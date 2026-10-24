import { opal, orHttpError } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => {
	const client = opal.using(fetch);
	const [req, assignees, tree] = await orHttpError(
		Promise.all([
			client.requirements.dossier({ id: Number(params.id) }),
			client.org.users.directory({}),
			client.requirements.tree({})
		])
	);
	// Re-parent candidates: anything that is not this row or below it.
	const below = new Set<number>([req.id]);
	let grew = true;
	while (grew) {
		grew = false;
		for (const i of tree.items) {
			if (i.parentId !== null && below.has(i.parentId) && !below.has(i.id)) {
				below.add(i.id);
				grew = true;
			}
		}
	}
	// Flow-down stays inside one project.
	const parents = tree.items.filter(
		(i) => !below.has(i.id) && i.lifecycleState !== 'cancelled' && i.projectId === req.projectId
	);
	return { req, assignees, parents };
};
