import { api, opal } from '#lib/api.js';
import {
	orNull,
	type AuthSettings,
	type ExtensionDetail,
	type ExtensionList,
	type LifecycleState,
	type OnshapeSettings
} from '#lib/components/settings/types.js';
import { sortRoles } from '#lib/components/users/roles.js';
import type { SignInConfig } from '#lib/session.svelte.js';
import type { PageLoad } from './$types';

/** Sections of other areas load through here: an absent or failing endpoint leaves them null. */
const optional = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

export const load: PageLoad = async ({ parent, fetch }) => {
	const { user } = await parent();
	const http = api.using(fetch);
	const org = opal.using(fetch).org;

	// --- org: project, roles, directory, system, agent ---
	const [project, system, agent, roles, people] = await Promise.all([
		orNull(org.project.get({})),
		org.settings.system({}),
		org.settings.agentActivation({}),
		orNull(org.roles.list({})),
		orNull(org.users.directory({}))
	]);

	// --- other areas: sign-in (auth), extensions, lifecycle, Onshape ---
	const extensions = await optional(
		http.get<ExtensionList>('/extensions').then(async (list) => {
			const entries = await Promise.all(
				list.items.map(
					async (e) =>
						[e.id, await orNull(http.get<ExtensionDetail>(`/extensions/${e.id}`))] as const
				)
			);
			return {
				list,
				details: Object.fromEntries(entries) as Record<string, ExtensionDetail | null>
			};
		})
	);
	const [signIn, auth, lifecycle, onshape] = await Promise.all([
		optional(http.get<SignInConfig>('/auth/config')),
		user.is_admin ? optional(http.get<AuthSettings>('/settings/auth')) : Promise.resolve(null),
		optional(http.get<LifecycleState>('/settings/lifecycle')),
		user.is_admin
			? optional(http.get<OnshapeSettings>('/settings/onshape'))
			: Promise.resolve(null)
	]);

	return {
		project,
		system,
		agent,
		roles: roles ? sortRoles(roles) : [],
		people: people ?? [],
		signIn,
		auth,
		extensions: extensions?.list ?? null,
		extensionDetails: extensions?.details ?? {},
		lifecycle,
		onshape
	};
};
