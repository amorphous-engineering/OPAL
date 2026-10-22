import { requireSession } from '#lib/session-guard.js';
import type { LayoutLoad } from './$types';

// Printable documents sit outside the app shell but still require a signed-in user.
export const load: LayoutLoad = async ({ url, fetch }) => {
	const user = await requireSession(url, fetch);
	return { user };
};
