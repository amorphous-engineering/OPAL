import { redirect } from '@sveltejs/kit';
import { opal, orHttpError } from '#lib/api.js';
import { session } from '#lib/session.svelte.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ parent, fetch, depends, url }) => {
	depends('app:overview');
	await parent();
	// A user who has not been through onboarding lands there first. The session
	// (not the layout's snapshot) is current once onboarding completes.
	if (session.user?.needs_onboarding) redirect(307, '/welcome');
	const projectId = Number(url.searchParams.get('project')) || undefined;
	const client = opal.using(fetch);
	const [overview, projects] = await orHttpError(
		Promise.all([client.reports.overview({ projectId }), client.org.projects.list({ limit: 200 })])
	);
	return { overview, projects: projects.items, projectId };
};
