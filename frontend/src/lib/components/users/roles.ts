import { opal } from '#lib/api.js';
import type { Role } from '@opal/shared';

export type { Role };

export interface RoleRef {
	id: number;
	name: string;
}

/** A person carrying the roles they hold. */
export interface Member {
	id: number;
	name: string;
	username?: string;
	avatarUrl?: string | null;
	roles?: RoleRef[];
}

/** System roles first, then custom roles; each group keeps its incoming order. */
export function sortRoles(roles: Role[]): Role[] {
	return [...roles].sort((a, b) => Number(b.isSystem) - Number(a.isSystem));
}

let names: Promise<string[]> | null = null;

/** Role names for pickers; fetched once per page load. */
export function roleNames(): Promise<string[]> {
	names ??= opal.org.roles
		.list({})
		.then((r) => sortRoles(r).map((x) => x.name))
		.catch((e) => {
			names = null;
			throw e;
		});
	return names;
}

/** Forget the cached names (after roles change). */
export function resetRoleNames() {
	names = null;
}
