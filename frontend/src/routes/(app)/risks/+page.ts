import { opal, orHttpError } from '#lib/api.js';
import { RISK_DISPOSITIONS, RISK_SEVERITIES, RISK_SORT_KEYS } from '@opal/shared';
import { filterProjectId, projectOptions } from '#lib/components/projects/projects.js'; // added by projects
import type { PageLoad } from './$types';

const PAGE_SIZE = 50;

const oneOf = <T extends string>(all: readonly T[], v: string | null): T | undefined =>
	all.find((x) => x === v);
const int = (v: string | null) => (v && Number.isInteger(Number(v)) ? Number(v) : undefined);

export const load: PageLoad = async ({ fetch, url }) => {
	const p = url.searchParams;
	const client = opal.using(fetch);
	const query = {
		q: p.get('q') ?? '',
		projectId: filterProjectId(url), // added by projects
		disposition: oneOf(RISK_DISPOSITIONS, p.get('disposition')),
		severity: oneOf(RISK_SEVERITIES, p.get('severity')),
		ownerId: int(p.get('owner_id')),
		probability: int(p.get('probability')),
		impact: int(p.get('impact')),
		residualProbability: int(p.get('residual_probability')),
		residualImpact: int(p.get('residual_impact')),
		active: p.get('active') === '1' || p.get('active') === 'true' ? true : undefined
	};
	const sort = oneOf(RISK_SORT_KEYS, p.get('sort')) ?? 'score';
	const dir = p.get('dir') === 'asc' ? 'asc' : 'desc';
	// The cursor is only valid for the filters it was issued under; a filter change drops `page`.
	const page = Math.max(1, Number(p.get('page') ?? 1) || 1);
	const cursor = page > 1 ? (p.get('cursor') ?? undefined) : undefined;
	const [list, owners, projects] = await orHttpError(
		Promise.all([
			client.risks.list({
				...query,
				q: query.q || undefined,
				sort,
				dir,
				cursor,
				limit: PAGE_SIZE
			}),
			client.org.users.directory({}),
			projectOptions(client) // added by projects
		])
	);
	return { list, owners, projects, query: { ...query, page: cursor ? page : 1 } };
};
