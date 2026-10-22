import { error } from '@sveltejs/kit';
import { api, ApiError } from '#lib/api.js';
import type {
	Assignee,
	Attachment,
	HoldTarget,
	IssueComment,
	IssueDetail,
	StepOption
} from '#lib/components/issues/issues.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params, depends }) => {
	depends('issue:detail');
	const client = api.using(fetch);
	const id = params.id;
	const [issue, holding, comments, attachments, steps, assignees] = await Promise.all([
		client.get<IssueDetail>(`/issues/${id}`).catch((e) => {
			if (e instanceof ApiError && e.status === 404) error(404, 'Issue not found');
			throw e;
		}),
		client.get<HoldTarget[]>(`/issues/${id}/holding`),
		client.get<IssueComment[]>(`/issues/${id}/comments`),
		client.get<Attachment[]>('/attachments', { issue_id: id }),
		client.get<StepOption[]>(`/issues/${id}/steps`),
		client.get<Assignee[]>('/users/directory')
	]);
	return { issue, holding, comments, attachments, steps, assignees };
};
