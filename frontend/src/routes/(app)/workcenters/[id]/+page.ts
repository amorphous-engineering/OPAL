import { opal, orHttpError } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => {
	const a = opal.using(fetch).org.workcenters;
	const id = Number(params.id);
	const [workcenter, work] = await orHttpError(Promise.all([a.get({ id }), a.work({ id })]));
	return { workcenter, work };
};
