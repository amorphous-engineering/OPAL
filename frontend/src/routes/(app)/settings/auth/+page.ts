import { redirect } from '@sveltejs/kit';
import { api } from '#lib/api.js';
import type { AuthSettings } from '#lib/components/settings/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ parent, fetch }) => {
	const { user } = await parent();
	if (!user.is_admin) redirect(307, '/settings');
	return { auth: await api.using(fetch).get<AuthSettings>('/settings/auth') };
};
