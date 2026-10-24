import { error, redirect } from '@sveltejs/kit';
import { ApiError, opal } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, parent, fetch }) => {
	const { user: me } = await parent();
	const id = Number(params.id);
	if (!Number.isInteger(id)) error(404, 'No such user');
	// Non-admins may only open their own profile.
	if (!me.is_admin && id !== me.id) redirect(307, `/users/${me.id}`);

	const http = opal.using(fetch).org.users;
	try {
		const [user, activity] = await Promise.all([
			http.get({ id }),
			http.activity({ id, limit: 15 })
		]);
		return { profile: user, activity, isSelf: me.id === id };
	} catch (e) {
		if (e instanceof ApiError && e.status === 404) error(404, 'No such user');
		throw e;
	}
};
