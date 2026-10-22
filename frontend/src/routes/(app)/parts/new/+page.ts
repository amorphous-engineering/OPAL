import { api } from '#lib/api.js';
import type { Part, PartSchema } from '#lib/components/parts/types.js';
import type { PageLoad } from './$types';

// The form never asks what the invoking context already knows:
// ?parent_id pre-fills PARENT, ?tier pre-selects the tier.
export const load: PageLoad = async ({ url, fetch }) => {
	const client = api.using(fetch);
	const parentId = Number(url.searchParams.get('parent_id')) || null;
	const tier = Number(url.searchParams.get('tier')) || null;
	const [schema, parent] = await Promise.all([
		client.get<PartSchema>('/parts/schema'),
		parentId ? client.get<Part>(`/parts/${parentId}`).catch(() => null) : Promise.resolve(null)
	]);
	return {
		schema,
		tier: tier && schema.tiers.some((t) => t.level === tier) ? tier : null,
		parent: parent ? { id: parent.id, internal_pn: parent.internal_pn, name: parent.name } : null
	};
};
