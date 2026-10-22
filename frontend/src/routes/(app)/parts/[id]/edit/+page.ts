import { error } from '@sveltejs/kit';
import { api, ApiError } from '#lib/api.js';
import type { Part, PartSchema } from '#lib/components/parts/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async (event) => {
	try {
		return await loadPart(event);
	} catch (e) {
		if (e instanceof ApiError) error(e.status as 404, e.message);
		throw e;
	}
};

async function loadPart({ params, fetch }: Parameters<PageLoad>[0]) {
	const client = api.using(fetch);
	const part = await client.get<Part>(`/parts/${params.id}`);
	const [schema, parent] = await Promise.all([
		client.get<PartSchema>('/parts/schema'),
		part.parent_id ? client.get<Part>(`/parts/${part.parent_id}`).catch(() => null) : null
	]);
	return {
		part,
		schema,
		parent: parent ? { id: parent.id, internal_pn: parent.internal_pn, name: parent.name } : null
	};
}
