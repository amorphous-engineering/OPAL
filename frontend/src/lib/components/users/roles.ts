import { api } from '#lib/api.js';

/** A role (qualification) as the roles list reports it. */
export interface Role {
	id: number;
	name: string;
	description: string | null;
	member_count: number;
}

export interface RoleRef {
	id: number;
	name: string;
}

/** A person carrying the roles they hold. */
export interface Member {
	id: number;
	name: string;
	username?: string;
	avatar_url?: string | null;
	roles?: RoleRef[];
}

/** `GET /roles` answers a list; tolerate an `items` envelope. */
export function roleList(res: Role[] | { items: Role[] }): Role[] {
	return Array.isArray(res) ? res : res.items;
}

let names: Promise<string[]> | null = null;

/** Role names for pickers; fetched once per page load. */
export function roleNames(): Promise<string[]> {
	names ??= api
		.get<Role[] | { items: Role[] }>('/roles')
		.then((r) => roleList(r).map((x) => x.name))
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
