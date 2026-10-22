import { redirect } from '@sveltejs/kit';
import { api } from '#lib/api.js';
import type { UserRecord } from '#lib/components/users/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ parent, url, fetch }) => {
	const { user } = await parent();
	// The roster is admin territory; everyone else gets their own profile.
	if (!user.is_admin) redirect(307, `/users/${user.id}`);

	const q = url.searchParams.get('q') ?? '';
	const status = url.searchParams.get('status') ?? 'active';
	const res = await api.using(fetch).get<{ items: UserRecord[]; total: number }>('/users', {
		search: q,
		is_active: status === 'all' ? undefined : status === 'inactive' ? false : true,
		limit: 1000
	});
	return { users: res.items, total: res.total, q, status };
};
