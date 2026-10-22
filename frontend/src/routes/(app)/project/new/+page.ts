import { redirect } from '@sveltejs/kit';
import { api } from '#lib/api.js';
import { orNull, type ProjectConfig } from '#lib/components/settings/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ parent, fetch }) => {
	const { user } = await parent();
	if (!user.is_admin) redirect(307, '/settings');
	// One instance, one project: an existing one is edited, not created again.
	const project = await orNull(api.using(fetch).get<ProjectConfig>('/project/config'));
	if (project) redirect(307, '/project/edit');
};
