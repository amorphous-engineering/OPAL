import { api, opal } from '#lib/api.js';
import { orNull, type AuthSettings } from '#lib/components/settings/types.js';
import { sortRoles } from '#lib/components/users/roles.js';
import type { SignInConfig } from '#lib/session.svelte.js';
import type { PageLoad } from './$types';

/** Sections of other areas load through here: an absent or failing endpoint leaves them null. */
const optional = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

export const load: PageLoad = async ({ parent, fetch }) => {
	const { user } = await parent();
	const http = api.using(fetch);
	const org = opal.using(fetch).org;

	// --- org: organization, roles, directory, system, agent ---
	const [organization, system, agent, roles, people] = await Promise.all([
		orNull(org.settings.get({})),
		org.settings.system({}),
		org.settings.agentActivation({}),
		orNull(org.roles.list({})),
		orNull(org.users.directory({}))
	]);

	// --- other areas: sign-in (auth), lifecycle (reports) ---
	const [signIn, auth, lifecycle, plugins] = await Promise.all([
		optional(http.get<SignInConfig>('/auth/config')),
		user.is_admin ? optional(http.get<AuthSettings>('/settings/auth')) : Promise.resolve(null),
		optional(opal.using(fetch).reports.lifecycle.get({})), // added by reports
		user.is_admin ? optional(opal.using(fetch).plugins.list({})) : Promise.resolve(null)
	]);

	return {
		organization,
		system,
		agent,
		roles: roles ? sortRoles(roles) : [],
		people: people ?? [],
		signIn,
		auth,
		lifecycle,
		plugins: plugins?.items ?? null
	};
};
