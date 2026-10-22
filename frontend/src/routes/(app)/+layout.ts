import { redirect } from '@sveltejs/kit';
import { api } from '#lib/api.js';
import { session } from '#lib/session.svelte.js';
import type { LayoutLoad } from './$types';

// Every page in (app) requires a signed-in user.
export const load: LayoutLoad = async ({ url, fetch }) => {
	const user = session.user ?? (await session.load(fetch));
	if (!user) redirect(307, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
	if (user.needs_profile_setup && url.pathname !== '/setup-profile')
		redirect(307, '/setup-profile');
	// Demo state shows as a banner on every page; a failed lookup just hides it.
	const lifecycle = await api
		.using(fetch)
		.get<{ demo_active: boolean }>('/settings/lifecycle')
		.catch(() => null);
	return { user, demoActive: lifecycle?.demo_active ?? false };
};
