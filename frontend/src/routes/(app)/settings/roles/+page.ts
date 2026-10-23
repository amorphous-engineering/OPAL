import { api } from '#lib/api.js';
import { roleList, type Member, type Role } from '#lib/components/users/roles.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => {
	const http = api.using(fetch);
	const [roles, people] = await Promise.all([
		http.get<Role[] | { items: Role[] }>('/roles'),
		http.get<Member[]>('/users/directory')
	]);
	return { roles: roleList(roles), people };
};
