import { opal, orHttpError } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, fetch }) => {
	const c = opal.using(fetch);
	const version = await orHttpError(
		c.procedures.versions.get({ versionId: Number(params.version_id) })
	);
	const versions = await orHttpError(c.procedures.versions.list({ id: version.procedureId }));
	return { version, versions };
};
