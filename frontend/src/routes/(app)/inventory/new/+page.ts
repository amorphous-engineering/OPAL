import { ApiError, opal } from '#lib/api.js';
import { toPickedPart } from '#lib/components/parts/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, url }) => {
	const client = opal.using(fetch);
	const partId = Number(url.searchParams.get('part_id')) || null;

	const [locations, part] = await Promise.all([
		client.inventory.locations({}).catch(() => []),
		partId
			? client.parts
					.get({ id: partId })
					.then(toPickedPart)
					.catch((e) => {
						if (e instanceof ApiError && e.status === 404) return null;
						throw e;
					})
			: Promise.resolve(null)
	]);
	const rules = part ? await client.inventory.receivingRules({ partId: part.id }) : null;

	return { locations: locations.map((l) => l.location), part, rules };
};
