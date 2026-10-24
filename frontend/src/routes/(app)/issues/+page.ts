import { opal } from '#lib/api.js';
import { ACTIVE_STATES, STATE_FILTER_DEFAULT } from '#lib/components/issues/issues.js';
import { session } from '#lib/session.svelte.js';
import { ISSUE_PRIORITIES, ISSUE_SORTS, ISSUE_STATUSES, ISSUE_TYPES } from '@opal/shared';
import { filterProjectId, projectOptions } from '#lib/components/projects/projects.js'; // added by projects
import type { PageLoad } from './$types';

const PAGE_SIZE = 50;

export const load: PageLoad = async ({ fetch, url }) => {
	const q = url.searchParams;
	const client = opal.using(fetch);
	const num = (k: string) => {
		const v = Number(q.get(k));
		return Number.isInteger(v) && v > 0 ? v : undefined;
	};
	// `assignee=me` is the shareable spelling of "assigned to the viewer".
	const assignee = q.get('assignee');
	// Default view: everything not done. `all` lifts it; a `status` link keeps its meaning.
	const state = q.get('state') ?? (q.get('status') ? 'all' : STATE_FILTER_DEFAULT);
	const page = Math.max(1, Number(q.get('page') ?? 1) || 1);
	const [issues, assignees, projects] = await Promise.all([
		client.issues.list({
			q: q.get('q') || undefined,
			projectId: filterProjectId(url), // added by projects
			issueType: ISSUE_TYPES.find((t) => t === q.get('type')),
			status: ISSUE_STATUSES.find((s) => s === q.get('status')),
			state: state === 'all' ? undefined : state === STATE_FILTER_DEFAULT ? ACTIVE_STATES : state,
			priority: ISSUE_PRIORITIES.find((p) => p === q.get('priority')),
			assignedToId: assignee === 'me' ? session.user?.id : Number(assignee) || undefined,
			partId: num('part'),
			executionId: num('execution'),
			procedureId: num('procedure'), // added by execution
			sort: ISSUE_SORTS.find((s) => s === q.get('sort')),
			dir: q.get('dir') === 'asc' ? 'asc' : 'desc',
			// The cursor is the row offset, so page numbers map straight onto it.
			cursor: page > 1 ? String((page - 1) * PAGE_SIZE) : undefined,
			limit: PAGE_SIZE
		}),
		client.issues.assignees({}),
		projectOptions(client) // added by projects
	]);
	return { issues, assignees, projects };
};
