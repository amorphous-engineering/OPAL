import { redirect } from '@sveltejs/kit';
import { api } from '#lib/api.js';
import type { OnshapeSettings } from '#lib/components/settings/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ parent, fetch }) => {
	const { user } = await parent();
	if (!user.is_admin) redirect(307, '/settings/extensions/opal.onshape');
	return { settings: await api.using(fetch).get<OnshapeSettings>('/settings/onshape') };
};
