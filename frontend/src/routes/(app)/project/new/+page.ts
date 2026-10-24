import { redirect } from '@sveltejs/kit';
import { opal } from '#lib/api.js';
import { orNull } from '#lib/components/settings/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ parent, fetch }) => {
	const { user } = await parent();
	if (!user.is_admin) redirect(307, '/settings');
	// One instance, one project: an existing one is edited, not created again.
	const project = await orNull(opal.using(fetch).org.project.get({}));
	if (project) redirect(307, '/settings#project');
};
