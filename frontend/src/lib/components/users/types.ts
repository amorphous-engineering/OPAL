import type { OrgUser, UserActivityEntry } from '@opal/shared';

export type UserRecord = OrgUser;
export type ActivityEntry = UserActivityEntry;

/** The claim page lives on this origin; a claim link is the token on it. */
export function claimUrl(token: string): string {
	return `${location.origin}/claim?token=${encodeURIComponent(token)}`;
}

/** Sign-in methods an account has, as facts. */
export function signInMethods(
	u: Pick<UserRecord, 'hasPassword' | 'hasPasskey' | 'ssoLinked'>
): string[] {
	const methods: string[] = [];
	if (u.hasPassword) methods.push('PASSWORD');
	if (u.hasPasskey) methods.push('PASSKEY');
	if (u.ssoLinked) methods.push('SSO');
	return methods;
}
