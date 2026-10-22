import { redirect } from '@sveltejs/kit';
import { api } from '#lib/api.js';
import { orNull, type ProjectConfig } from '#lib/components/settings/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ parent, fetch }) => {
	const { user } = await parent();
	if (!user.is_admin) redirect(307, '/settings');
	const project = await orNull(api.using(fetch).get<ProjectConfig>('/project/config'));
	// Nothing to edit yet: this instance still needs its project.
	if (!project) redirect(307, '/project/new');
	return { project };
};
