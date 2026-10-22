import { api } from '#lib/api.js';
import type { TreeResponse } from '#lib/components/requirements/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const a = api.using(fetch);
	const [tree, assignees] = await Promise.all([
		a.get<TreeResponse>('/requirements/tree'),
		a.get<{ id: number; name: string }[]>('/users/directory')
	]);
	const parent = url.searchParams.get('parent');
	return {
		parents: tree.items.filter((i) => i.lifecycle_state !== 'cancelled'),
		assignees,
		parentId: parent ? Number(parent) : null
	};
};
