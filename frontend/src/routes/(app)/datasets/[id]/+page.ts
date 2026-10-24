import { opal, orHttpError } from '#lib/api.js';
import { procedureOptions } from '#lib/components/datasets/procedures.js';
import type { PageLoad } from './$types';

const POINT_LIMIT = 100;

export const load: PageLoad = async ({ fetch, params, url }) => {
	const client = opal.using(fetch);
	const id = Number(params.id);
	const [dataset, points, procedures] = await orHttpError(
		Promise.all([
			client.datasets.get({ id }),
			client.datasets.points.list({ id, limit: POINT_LIMIT }),
			procedureOptions(fetch)
		])
	);
	// The charted field lives in the query string: the one named, else the first marked charted.
	const numeric = dataset.schema.fields.filter((f) => f.type === 'number');
	const field =
		numeric.find((f) => f.name === url.searchParams.get('field')) ??
		numeric.find((f) => f.chart) ??
		numeric[0];
	const chart =
		field && dataset.pointCount > 0
			? await orHttpError(client.datasets.chart({ id, field: field.name }))
			: null;
	return { dataset, points, procedures, chart, field: field?.name ?? null };
};
