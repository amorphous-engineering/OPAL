import { error, redirect } from '@sveltejs/kit';
import { api, ApiError } from '#lib/api.js';
import type { ActivityEntry, UserRecord } from '#lib/components/users/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, parent, fetch }) => {
	const { user: me } = await parent();
	const id = Number(params.id);
	if (!Number.isInteger(id)) error(404, 'No such user');
	// Non-admins may only open their own profile.
	if (!me.is_admin && id !== me.id) redirect(307, `/users/${me.id}`);

	const http = api.using(fetch);
	try {
		const [user, activity] = await Promise.all([
			http.get<UserRecord>(`/users/${id}`),
			http.get<ActivityEntry[]>(`/users/${id}/activity`, { limit: 15 })
		]);
		return { profile: user, activity, isSelf: me.id === id };
	} catch (e) {
		if (e instanceof ApiError && e.status === 404) error(404, 'No such user');
		throw e;
	}
};
