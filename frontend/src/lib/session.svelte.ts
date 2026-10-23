/** Signed-in identity and the instance's sign-in configuration. */
import { api, ApiError } from '#lib/api.js';

export interface CurrentUser {
	id: number;
	username: string;
	name: string;
	email: string | null;
	is_admin: boolean;
	avatar_url?: string | null;
	needs_onboarding: boolean;
	needs_profile_setup: boolean;
}

export interface SignInConfig {
	needs_setup: boolean;
	password_login_enabled: boolean;
	passkeys_enabled: boolean;
	oidc_enabled: boolean;
	oidc_provider_name: string | null;
}

class Session {
	user = $state<CurrentUser | null>(null);
	loaded = $state(false);

	/** Resolve the cookie to a user; null when signed out. */
	async load(fetchFn?: typeof fetch): Promise<CurrentUser | null> {
		try {
			this.user = await (fetchFn ? api.using(fetchFn) : api).get<CurrentUser>('/auth/me');
		} catch (e) {
			if (!(e instanceof ApiError) || e.status !== 401) throw e;
			this.user = null;
		}
		this.loaded = true;
		return this.user;
	}

	set(user: CurrentUser | null) {
		this.user = user;
		this.loaded = true;
	}

	async logout() {
		await api.post('/auth/logout');
		this.user = null;
	}
}

export const session = new Session();

export function getSignInConfig() {
	return api.get<SignInConfig>('/auth/config');
}

/** Where a freshly signed-in user lands. */
export function landingFor(user: CurrentUser, next: string | null): string {
	if (user.needs_profile_setup) return '/setup-profile';
	if (user.needs_onboarding) return '/welcome';
	return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}
