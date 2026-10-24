import { opal } from '#lib/api.js';
import type { PartRef } from '#lib/components/parts/types.js';
import type { PageLoad } from './$types';

// The form never asks what the invoking context already knows:
// ?assembly pre-fills ADD TO ASSEMBLY, ?tier pre-selects the tier.
export const load: PageLoad = async ({ url, fetch }) => {
	const client = opal.using(fetch);
	const assemblyId = Number(url.searchParams.get('assembly')) || null;
	const tier = Number(url.searchParams.get('tier')) || null;
	const [schema, assembly] = await Promise.all([
		client.parts.schema({}),
		assemblyId ? client.parts.get({ id: assemblyId }).catch(() => null) : Promise.resolve(null)
	]);
	const ref: PartRef | null = assembly
		? { id: assembly.id, internal_pn: assembly.internalPn, name: assembly.name }
		: null;
	return {
		schema,
		tier: tier && schema.tiers.some((t) => t.level === tier) ? tier : null,
		assembly: ref
	};
};
