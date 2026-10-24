import { opal, orHttpError } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, fetch }) => {
	const client = opal.using(fetch);
	const id = Number(params.id);
	const [detail, schema, suppliers, poLines] = await orHttpError(
		Promise.all([
			client.parts.detail({ id }),
			client.parts.schema({}),
			client.purchasing.catalog.forPart({ id }), // added by purchasing
			client.purchasing.catalog.poLinesForPart({ id }) // added by purchasing
		])
	);
	return { detail, fields: schema.customFields, suppliers, poLines };
};
