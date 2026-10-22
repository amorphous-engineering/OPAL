import { api } from '#lib/api.js';
import { AUDIT_PAGE_SIZE as PAGE_SIZE, type AuditEntry } from '#lib/components/audit/audit.js';
import type { PageLoad } from './$types';

export interface Facets {
	entity_types: { value: string; label: string }[];
	users: { id: number; name: string }[];
}

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
	const client = api.using(fetch);
	const [facets, list] = await Promise.all([
		client.get<Facets>('/audit/facets'),
		client.get<{ items: AuditEntry[]; total: number }>('/audit', {
			table_name: q.get('entity'),
			record_id: q.get('record'),
			action: q.get('action'),
			user_id: q.get('user'),
			date_from: localDayStart(from),
			date_to: localDayStart(to, 1),
			skip: (page - 1) * PAGE_SIZE,
			limit: PAGE_SIZE
		})
	]);
	return { facets, ...list, page };
};
