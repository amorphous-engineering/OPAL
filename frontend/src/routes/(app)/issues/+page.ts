import { api, type Page } from '#lib/api.js';
import {
	ACTIVE_STATES,
	STATE_FILTER_DEFAULT,
	type Assignee,
	type Issue
} from '#lib/components/issues/issues.js';
import { session } from '#lib/session.svelte.js';
import type { PageLoad } from './$types';

const PAGE_SIZE = 50;

export const load: PageLoad = async ({ fetch, url }) => {
	const q = url.searchParams;
	const client = api.using(fetch);
	// `assignee=me` is the shareable spelling of "assigned to the viewer".
	const assignee = q.get('assignee');
	// Default view: everything not done. `all` lifts it; a legacy `status` link keeps its meaning.
	const state = q.get('state') ?? (q.get('status') ? 'all' : STATE_FILTER_DEFAULT);
	const [issues, assignees] = await Promise.all([
		client.get<Page<Issue>>('/issues', {
			search: q.get('q'),
			issue_type: q.get('type'),
			status: q.get('status'),
			state: state === 'all' ? null : state === STATE_FILTER_DEFAULT ? ACTIVE_STATES : state,
			priority: q.get('priority'),
			assigned_to_id: assignee === 'me' ? session.user?.id : assignee,
			part_id: q.get('part'),
			procedure_id: q.get('procedure'),
			procedure_instance_id: q.get('execution'),
			sort: q.get('sort'),
			dir: q.get('dir'),
			page: q.get('page') ?? 1,
			page_size: PAGE_SIZE
		}),
		client.get<Assignee[]>('/users/directory')
	]);
	return { issues, assignees };
};
