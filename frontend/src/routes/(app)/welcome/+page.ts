import { api } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => {
	const { mode } = await api.using(fetch).get<{ mode: 'setup' | 'tutorial' }>('/welcome');
	return { mode };
};
