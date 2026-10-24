import { ApiError } from '#lib/api.js';

// Organization, system and agent types come from the shared contracts (org area).
export type { AgentActivation, OrgSettings, PartNumbering, SystemInfo, Tier } from '@opal/shared';

export interface AuthSettings {
	password_login_enabled: boolean;
	passkeys_enabled: boolean;
	oidc_enabled: boolean;
	oidc_issuer: string;
	oidc_client_id: string;
	has_client_secret: boolean;
	oidc_scopes: string;
	oidc_provider_name: string;
	oidc_groups_claim: string;
	oidc_admin_group: string;
	oidc_auto_create_users: boolean;
	oidc_redirect_base_url: string;
	callback_url: string;
}

/** 10485760 → 10 MB. */
export function bytes(n: number | null | undefined): string {
	if (n === null || n === undefined) return '—';
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Fetch that maps a 404 to null (an absent optional resource). */
export async function orNull<T>(p: Promise<T>): Promise<T | null> {
	try {
		return await p;
	} catch (e) {
		if (e instanceof ApiError && e.status === 404) return null;
		throw e;
	}
}
