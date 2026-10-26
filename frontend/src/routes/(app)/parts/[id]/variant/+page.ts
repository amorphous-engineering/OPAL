import { error } from '@sveltejs/kit';
import { opal, orHttpError } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, fetch }) => {
	const client = opal.using(fetch);
	const [detail, schema] = await orHttpError(
		Promise.all([client.parts.detail({ id: Number(params.id) }), client.parts.schema({})])
	);
	if (!detail.family.nextNumber) {
		error(
			409,
			detail.family.variants
				? 'No variant code is free for this part'
				: 'Part number variants are off'
		);
	}
	return { part: detail.part, nextNumber: detail.family.nextNumber, schema };
};
