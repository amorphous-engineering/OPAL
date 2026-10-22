export interface UserRecord {
	id: number;
	name: string;
	username: string;
	email: string | null;
	is_active: boolean;
	is_admin: boolean;
	created_at: string;
	updated_at: string;
	last_seen_at: string | null;
	current_activity: string | null;
	is_online: boolean;
	has_password: boolean;
	has_passkey: boolean;
	sso_linked: boolean;
}

export interface ActivityEntry {
	timestamp: string;
	table: string;
	action: string;
	subject: string | null;
}

export interface ClaimLink {
	url: string;
	expires_at: string;
}

/** The claim page lives on this origin; the API only knows its own host. */
export function claimUrl(link: ClaimLink): string {
	const token = new URL(link.url).searchParams.get('token') ?? '';
	return `${location.origin}/claim?token=${token}`;
}

/** Sign-in methods an account has, as facts. */
export function signInMethods(
	u: Pick<UserRecord, 'has_password' | 'has_passkey' | 'sso_linked'>
): string[] {
	const methods: string[] = [];
	if (u.has_password) methods.push('PASSWORD');
	if (u.has_passkey) methods.push('PASSKEY');
	if (u.sso_linked) methods.push('SSO');
	return methods;
}
