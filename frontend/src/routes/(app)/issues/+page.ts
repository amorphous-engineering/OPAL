import { api, type Page } from '#lib/api.js';
import type { Assignee, Issue } from '#lib/components/issues/issues.js';
import type { PageLoad } from './$types';

const PAGE_SIZE = 50;

export const load: PageLoad = async ({ fetch, url }) => {
	const q = url.searchParams;
	const sort = q.get('sort');
	const client = api.using(fetch);
	const [issues, assignees] = await Promise.all([
		client.get<Page<Issue>>('/issues', {
			search: q.get('q'),
			issue_type: q.get('type'),
			disp_state: q.get('state'),
			priority: q.get('priority'),
			assigned_to_id: q.get('assignee'),
			part_id: q.get('part'),
			procedure_id: q.get('procedure'),
			procedure_instance_id: q.get('execution'),
			sort,
			dir: q.get('dir'),
			page: q.get('page') ?? 1,
			page_size: PAGE_SIZE
		}),
		client.get<Assignee[]>('/users/directory')
	]);
	return { issues, assignees };
};
