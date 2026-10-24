import { opal, orHttpError } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, fetch }) => {
	const client = opal.using(fetch);
	const [part, schema] = await orHttpError(
		Promise.all([client.parts.get({ id: Number(params.id) }), client.parts.schema({})])
	);
	return { part, schema };
};
