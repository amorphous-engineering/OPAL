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

let list: Promise<Role[]> | null = null;

/** Roles for pickers, system roles first; fetched once per page load. */
export function roleList(): Promise<Role[]> {
	list ??= opal.org.roles
		.list({})
		.then(sortRoles)
		.catch((e) => {
			list = null;
			throw e;
		});
	return list;
}

/** The roles a procedure of this project may name: the organization's and the project's own. */
export const offeredIn = (roles: Role[], projectId: number | null): Role[] =>
	roles.filter((r) => r.projectId === null || r.projectId === projectId);

/** Role names for pickers. */
export const roleNames = (): Promise<string[]> => roleList().then((r) => r.map((x) => x.name));

/** Forget the cached roles (after roles change). */
export function resetRoleNames() {
	list = null;
}
