import { redirect } from '@sveltejs/kit';
import { session } from '#lib/session.svelte.js';
import type { LayoutLoad } from './$types';

// Printable pages carry no application chrome but still require a signed-in user.
export const load: LayoutLoad = async ({ url, fetch }) => {
	const user = session.user ?? (await session.load(fetch));
	if (!user) redirect(307, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
	return { user };
};
