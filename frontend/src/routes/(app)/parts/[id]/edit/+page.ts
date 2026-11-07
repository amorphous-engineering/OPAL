import { opal, orHttpError } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, fetch }) => {
	const client = opal.using(fetch);
	const [detail, schema] = await orHttpError(
		Promise.all([client.parts.detail({ id: Number(params.id) }), client.parts.schema({})])
	);
	return { part: detail.part, unitLocked: detail.unitLocked, identityLocked: detail.identityLocked, schema };
};
