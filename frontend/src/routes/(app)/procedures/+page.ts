import { opal, orHttpError } from '#lib/api.js';
import { PROCEDURE_SORT_KEYS, PROCEDURE_STATUSES, PROCEDURE_TYPES } from '@opal/shared';
import type { PageLoad } from './$types';

const PAGE_SIZE = 50;

const oneOf = <T extends string>(all: readonly T[], v: string | null): T | undefined =>
	all.find((x) => x === v);

export const load: PageLoad = async ({ url, fetch }) => {
	const q = url.searchParams;
	const client = opal.using(fetch);
	const page = Math.max(1, Number(q.get('page') ?? 1) || 1);
	const cursor = page > 1 ? (q.get('cursor') ?? undefined) : undefined;
	const projectId = Number(q.get('project')) || undefined;
	const [result, projects] = await orHttpError(
		Promise.all([
			client.procedures.list({
				q: q.get('q') || undefined,
				status: oneOf(PROCEDURE_STATUSES, q.get('status')),
				procedureType: oneOf(PROCEDURE_TYPES, q.get('type')),
				projectId,
				sort: oneOf(PROCEDURE_SORT_KEYS, q.get('sort')) ?? 'updatedAt',
				dir: q.get('dir') === 'asc' ? 'asc' : 'desc',
				cursor,
				limit: PAGE_SIZE
			}),
			client.org.projects.list({ limit: 200 })
		])
	);
	return { result, projects: projects.items, page: cursor ? page : 1 };
};
