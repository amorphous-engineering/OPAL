import { requireSession } from '#lib/session-guard.js';
import type { LayoutLoad } from './$types';

// Every page in (app) requires a signed-in user.
export const load: LayoutLoad = async ({ url, fetch }) => {
	const user = await requireSession(url, fetch, { profileSetup: true });
	return { user };
};
