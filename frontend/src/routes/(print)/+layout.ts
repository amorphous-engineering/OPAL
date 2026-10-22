import { redirect } from '@sveltejs/kit';
import { session } from '#lib/session.svelte.js';
import type { LayoutLoad } from './$types';

// Print routes sit outside the app shell (no sidebar, no header) but still need a session.
export const load: LayoutLoad = async ({ url, fetch }) => {
	const user = session.user ?? (await session.load(fetch));
	if (!user) redirect(307, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
	return { user };
};
