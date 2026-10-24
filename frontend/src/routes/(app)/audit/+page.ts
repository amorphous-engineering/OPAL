import { opal } from '#lib/api.js';
import { AUDIT_PAGE_SIZE as PAGE_SIZE } from '#lib/components/audit/audit.js';
import { AUDIT_ACTIONS } from '@opal/shared';
import { dayStart } from '#lib/format.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ url, fetch }) => {
	const q = url.searchParams;
	const page = Math.max(1, Number(q.get('page')) || 1);
	const from = q.get('from') ?? '';
	const to = q.get('to') ?? '';
	const action = AUDIT_ACTIONS.find((a) => a === q.get('action'));
	const client = opal.using(fetch).platform.audit;
	const [facets, list] = await Promise.all([
		client.facets({}),
		client.list({
			entity: q.get('entity') || undefined,
			entityId: Number(q.get('record')) || undefined,
			action,
			userId: Number(q.get('user')) || undefined,
			from: dayStart(from),
			to: dayStart(to, 1),
			offset: (page - 1) * PAGE_SIZE,
			limit: PAGE_SIZE
		})
	]);
	return { facets, ...list, page };
};
