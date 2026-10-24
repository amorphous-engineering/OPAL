import { redirect } from '@sveltejs/kit';
import { opal } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ parent, url, fetch }) => {
	const { user } = await parent();
	// The roster is admin territory; everyone else gets their own profile.
	if (!user.is_admin) redirect(307, `/users/${user.id}`);

	const q = url.searchParams.get('q') ?? '';
	const status = url.searchParams.get('status') ?? 'active';
	const res = await opal.using(fetch).org.users.list({
		search: q || undefined,
		isActive: status === 'all' ? undefined : status !== 'inactive',
		limit: 500
	});
	return { users: res.items, total: res.total, q, status };
};
