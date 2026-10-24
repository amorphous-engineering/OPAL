import { error } from '@sveltejs/kit';
import { ApiError, opal } from '#lib/api.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ fetch, params, depends }) => {
	depends('issue:detail');
	const client = opal.using(fetch);
	const id = Number(params.id);
	if (!Number.isInteger(id) || id < 1) error(404, 'Issue not found');
	const [issue, holding, comments, attachments, steps, assignees] = await Promise.all([
		client.issues.get({ id }).catch((e) => {
			if (e instanceof ApiError && e.status === 404) error(404, 'Issue not found');
			throw e;
		}),
		client.issues.holding({ id }),
		client.issues.listComments({ id }),
		client.platform.attachments.list({ ownerType: 'issue', ownerId: id }),
		client.issues.steps({ id }),
		client.issues.assignees({})
	]);
	return { issue, holding, comments, attachments, steps, assignees };
};
