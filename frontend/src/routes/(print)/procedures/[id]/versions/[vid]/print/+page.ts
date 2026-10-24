import { error } from '@sveltejs/kit';
import { opal, orHttpError } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, fetch }) => {
	const version = await orHttpError(
		opal.using(fetch).procedures.versions.get({ versionId: Number(params.vid) })
	);
	if (String(version.procedureId) !== params.id) error(404, 'Version not found');
	return { version };
};
