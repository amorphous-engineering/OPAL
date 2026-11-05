import { opal, orHttpError } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, fetch, url }) => {
	const client = opal.using(fetch);
	const id = Number(params.id);
	const [detail, schema, suppliers, poLines, stock, tests, procedureUse, consumed, qr] =
		await orHttpError(
			Promise.all([
				client.parts.detail({ id }),
				client.parts.schema({}),
				client.purchasing.catalog.forPart({ id }), // added by purchasing
				client.purchasing.catalog.poLinesForPart({ id }), // added by purchasing
				client.inventory.list({ partId: id, hasStock: true, limit: 200 }), // added by inventory
				client.inventory.templates.list({ partId: id }), // added by inventory
				client.parts.procedureUse({ id }),
				client.parts.consumption({ id, limit: 50 }),
				// The tag's QR; a failure leaves the tag without one.
				client.parts.qrcode({ id, origin: url.origin }).catch(() => null)
			])
		);
	return {
		detail,
		fields: schema.customFields,
		suppliers,
		poLines,
		stock: stock.items,
		tests,
		procedureUse,
		consumed,
		qr: qr ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr.svg)}` : null
	};
};
