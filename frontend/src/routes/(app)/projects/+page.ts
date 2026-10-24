import { opal, orHttpError } from '#lib/api.js';
import { PROJECT_STATES } from '@opal/shared';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const q = url.searchParams.get('q') ?? '';
	const state = PROJECT_STATES.find((s) => s === url.searchParams.get('state'));
	const projects = await orHttpError(
		opal.using(fetch).org.projects.list({ search: q || undefined, state, limit: 500 })
	);
	return { projects: projects.items };
};
