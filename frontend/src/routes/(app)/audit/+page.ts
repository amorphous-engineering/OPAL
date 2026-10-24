import { opal } from '#lib/api.js';
import { AUDIT_PAGE_SIZE as PAGE_SIZE } from '#lib/components/audit/audit.js';
import { AUDIT_ACTIONS } from '@opal/shared';
import type { PageLoad } from './$types';

/** A local calendar day (YYYY-MM-DD) as a UTC instant, so "today" means the viewer's today. */
function localDayStart(day: string, plusDays = 0): string | undefined {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
	if (!m) return undefined;
	return new Date(+m[1], +m[2] - 1, +m[3] + plusDays).toISOString();
}

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
			from: localDayStart(from),
			to: localDayStart(to, 1),
			offset: (page - 1) * PAGE_SIZE,
			limit: PAGE_SIZE
		})
	]);
	return { facets, ...list, page };
};
