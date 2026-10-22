import { api } from '#lib/api.js';
import {
	orNull,
	type AgentActivation,
	type AuthSettings,
	type ExtensionList,
	type LifecycleState,
	type ProjectConfig,
	type SystemInfo
} from '#lib/components/settings/types.js';
import type { SignInConfig } from '#lib/session.svelte.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ parent, fetch }) => {
	const { user } = await parent();
	const http = api.using(fetch);
	const [project, signIn, auth, system, agent, extensions, lifecycle] = await Promise.all([
		orNull(http.get<ProjectConfig>('/project/config')),
		http.get<SignInConfig>('/auth/config'),
		// Issuer and client details are admin-only.
		user.is_admin ? http.get<AuthSettings>('/settings/auth') : Promise.resolve(null),
		http.get<SystemInfo>('/settings/system'),
		http.get<AgentActivation>('/settings/agent-activation'),
		http.get<ExtensionList>('/extensions'),
		http.get<LifecycleState>('/settings/lifecycle')
	]);
	return { project, signIn, auth, system, agent, extensions, lifecycle };
};
