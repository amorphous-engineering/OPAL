import { api } from '#lib/api.js';
import {
	orNull,
	type AgentActivation,
	type AuthSettings,
	type ExtensionDetail,
	type ExtensionList,
	type LifecycleState,
	type OnshapeSettings,
	type ProjectConfig,
	type SystemInfo
} from '#lib/components/settings/types.js';
import { roleList, type Member, type Role } from '#lib/components/users/roles.js';
import type { SignInConfig } from '#lib/session.svelte.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ parent, fetch }) => {
	const { user } = await parent();
	const http = api.using(fetch);
	const none = <T>() => Promise.resolve<T | null>(null);

	// Each extension's own detail loads once the list is known; one failing detail is
	// omitted rather than breaking the page.
	const extensionsWithDetails = http.get<ExtensionList>('/extensions').then(async (list) => {
		const entries = await Promise.all(
			list.items.map(
				async (e) => [e.id, await orNull(http.get<ExtensionDetail>(`/extensions/${e.id}`))] as const
			)
		);
		return { list, details: Object.fromEntries(entries) as Record<string, ExtensionDetail | null> };
	});

	const [project, signIn, auth, system, agent, ext, lifecycle, roles, people, onshape] =
		await Promise.all([
			orNull(http.get<ProjectConfig>('/project/config')),
			http.get<SignInConfig>('/auth/config'),
			// Issuer and client details are admin-only.
			user.is_admin ? orNull(http.get<AuthSettings>('/settings/auth')) : none<AuthSettings>(),
			http.get<SystemInfo>('/settings/system'),
			http.get<AgentActivation>('/settings/agent-activation'),
			extensionsWithDetails,
			http.get<LifecycleState>('/settings/lifecycle'),
			orNull(http.get<Role[] | { items: Role[] }>('/roles')),
			orNull(http.get<Member[]>('/users/directory')),
			user.is_admin
				? orNull(http.get<OnshapeSettings>('/settings/onshape'))
				: none<OnshapeSettings>()
		]);
	return {
		project,
		signIn,
		auth,
		system,
		agent,
		extensions: ext.list,
		extensionDetails: ext.details,
		lifecycle,
		roles: roles ? roleList(roles) : [],
		people: people ?? [],
		onshape
	};
};
