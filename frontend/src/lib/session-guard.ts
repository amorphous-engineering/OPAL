/**
 * The one session guard for every signed-in route group: (app), (print), (report).
 * Signed out sends the visitor to /login and back to where they were going.
 */
import { redirect } from '@sveltejs/kit';
import { session, type CurrentUser } from '#lib/session.svelte.js';

export async function requireSession(
	url: URL,
	fetch: typeof globalThis.fetch,
	opts: { profileSetup?: boolean } = {}
): Promise<CurrentUser> {
	const user = session.user ?? (await session.load(fetch));
	if (!user) redirect(307, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
	// The app shell holds new accounts at profile setup until it is done.
	if (opts.profileSetup && user.needs_profile_setup && url.pathname !== '/setup-profile')
		redirect(307, '/setup-profile');
	return user;
}
