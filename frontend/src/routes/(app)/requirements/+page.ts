import { api } from '#lib/api.js';
import type { Summary, TreeResponse } from '#lib/components/requirements/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => {
	const a = api.using(fetch);
	const [tree, summary] = await Promise.all([
		a.get<TreeResponse>('/requirements/tree'),
		a.get<Summary>('/requirements/summary')
	]);
	return { tree, summary };
};
