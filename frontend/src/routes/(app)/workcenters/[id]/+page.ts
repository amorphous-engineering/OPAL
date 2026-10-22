import { api } from '#lib/api.js';
import type { Workcenter, WorkcenterWork } from '#lib/components/workcenters/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params }) => {
	const a = api.using(fetch);
	const [workcenter, work] = await Promise.all([
		a.get<Workcenter>(`/workcenters/${params.id}`),
		a.get<WorkcenterWork>(`/workcenters/${params.id}/work`)
	]);
	return { workcenter, work };
};
