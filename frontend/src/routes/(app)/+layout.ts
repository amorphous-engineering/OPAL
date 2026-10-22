import { api } from '#lib/api.js';
import { requireSession } from '#lib/session-guard.js';
import type { LayoutLoad } from './$types';

// Every page in (app) requires a signed-in user.
export const load: LayoutLoad = async ({ url, fetch }) => {
	const user = await requireSession(url, fetch, { profileSetup: true });
	// Demo state shows as a banner on every page; a failed lookup just hides it.
	const lifecycle = await api
		.using(fetch)
		.get<{ demo_active: boolean }>('/settings/lifecycle')
		.catch(() => null);
	return { user, demoActive: lifecycle?.demo_active ?? false };
};
