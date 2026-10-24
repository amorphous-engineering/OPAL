import { opal, orHttpError } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, fetch }) => {
	const diff = await orHttpError(
		opal.using(fetch).procedures.versions.diff({
			id: Number(params.id),
			versionA: Number(params.v1),
			versionB: Number(params.v2)
		})
	);
	return { diff };
};
