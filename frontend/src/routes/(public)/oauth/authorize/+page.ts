import { requireSession } from '#lib/session-guard.js';
import type { PageLoad } from './$types';

// Approval needs a signed-in user. Signed out goes to /login and comes back with the same query.
export const load: PageLoad = async ({ url, fetch }) => {
	const user = await requireSession(url, fetch);
	return { user };
};
