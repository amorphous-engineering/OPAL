/** Signed-in identity and the instance's sign-in configuration. */
import { ApiError, opal } from '#lib/api.js';
import type { AuthUser } from '@opal/shared';

export interface CurrentUser {
	id: number;
	username: string;
	name: string;
	email: string | null;
	avatar_url?: string | null;
	job_title?: string | null;
	is_admin: boolean;
	needs_onboarding: boolean;
	needs_profile_setup: boolean;
}

/** `GET /auth/config` from the old API; the settings page still reads it. */
export interface SignInConfig {
	needs_setup: boolean;
	password_login_enabled: boolean;
	passkeys_enabled: boolean;
	oidc_enabled: boolean;
	oidc_provider_name: string | null;
}

/** `auth.config` from the new server. */
export type AuthConfig = Awaited<ReturnType<typeof opal.auth.config>>;

/**
 * The new server's user, in the shape pages not yet ported still read (snake_case flags).
 * The new server has no onboarding or profile-setup state, so both are false.
 */
export function toCurrentUser(u: AuthUser): CurrentUser {
	return {
		id: u.id,
		username: u.username,
		name: u.name,
		email: u.email,
		is_admin: u.isAdmin,
		needs_onboarding: u.needsOnboarding,
		needs_profile_setup: u.needsProfileSetup
	};
}

class Session {
	user = $state<CurrentUser | null>(null);
	loaded = $state(false);

	/** Resolve the cookie to a user; null when signed out. */
	async load(fetchFn?: typeof fetch): Promise<CurrentUser | null> {
		try {
			this.user = toCurrentUser(await (fetchFn ? opal.using(fetchFn) : opal).auth.me({}));
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
		await opal.auth.logout({});
		this.user = null;
	}
}

export const session = new Session();

export function getSignInConfig() {
	return opal.auth.config({});
}

/** Where a freshly signed-in user lands. */
export function landingFor(user: CurrentUser, next: string | null): string {
	if (user.needs_profile_setup) return '/setup-profile';
	if (user.needs_onboarding) return '/welcome';
	return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}
