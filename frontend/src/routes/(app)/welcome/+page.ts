import { opal } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch }) => {
	const { mode } = await opal.using(fetch).org.welcome.state({});
	return { mode };
};
