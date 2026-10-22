import { redirect } from '@sveltejs/kit';
import { api } from '#lib/api.js';
import type { Overview } from '#lib/components/overview/types.js';
import { session } from '#lib/session.svelte.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ parent, fetch, depends }) => {
	depends('app:overview');
	await parent();
	// A user who has not been through onboarding lands there first. The session
	// (not the layout's snapshot) is current once onboarding completes.
	if (session.user?.needs_onboarding) redirect(307, '/welcome');
	return { overview: await api.using(fetch).get<Overview>('/overview') };
};
