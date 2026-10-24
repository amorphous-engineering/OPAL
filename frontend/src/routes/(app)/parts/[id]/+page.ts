import { opal, orHttpError } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, fetch }) => {
	const client = opal.using(fetch);
	const id = Number(params.id);
	const [detail, schema] = await orHttpError(
		Promise.all([client.parts.detail({ id }), client.parts.schema({})])
	);
	return { detail, fields: schema.customFields };
};
