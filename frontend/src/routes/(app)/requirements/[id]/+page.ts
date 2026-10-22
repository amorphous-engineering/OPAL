import { error } from '@sveltejs/kit';
import { api, ApiError } from '#lib/api.js';
import type { Dossier, TreeResponse } from '#lib/components/requirements/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => {
	const a = api.using(fetch);
	try {
		const [req, assignees, tree] = await Promise.all([
			a.get<Dossier>(`/requirements/${params.id}/dossier`),
			a.get<{ id: number; name: string }[]>('/users/directory'),
			a.get<TreeResponse>('/requirements/tree')
		]);
		// Re-parent candidates: anything that is not this row or below it.
		const below = new Set<number>([req.id]);
		let grew = true;
		while (grew) {
			grew = false;
			for (const i of tree.items) {
				if (i.parent_id !== null && below.has(i.parent_id) && !below.has(i.id)) {
					below.add(i.id);
					grew = true;
				}
			}
		}
		const parents = tree.items.filter((i) => !below.has(i.id) && i.lifecycle_state !== 'cancelled');
		return { req, assignees, parents };
	} catch (e) {
		if (e instanceof ApiError) error(e.status, e.message);
		throw e;
	}
};
