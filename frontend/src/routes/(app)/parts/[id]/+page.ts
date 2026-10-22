import { error } from '@sveltejs/kit';
import { api, ApiError } from '#lib/api.js';
import type { PartDetail, PartSchema } from '#lib/components/parts/types.js';
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
	const [detail, schema] = await Promise.all([
		client.get<PartDetail>(`/parts/${params.id}/detail`),
		client.get<PartSchema>('/parts/schema')
	]);
	return { detail, fields: schema.custom_fields };
}
