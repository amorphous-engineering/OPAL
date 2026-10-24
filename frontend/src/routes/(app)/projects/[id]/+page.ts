import { opal, orHttpError } from '#lib/api.js';
import type { PageLoad } from './$types';

const ROWS = 10;

export const load: PageLoad = async ({ fetch, params }) => {
	const client = opal.using(fetch);
	const projectId = Number(params.id);
	// added by execution: a failed list leaves the section out
	const executions = client.execution.list({ projectId, limit: ROWS }).catch(() => null);
	const [project, requirements, risks, issues, procedures, datasets, executionList] =
		await orHttpError(
			Promise.all([
				client.org.projects.get({ id: projectId }),
				client.requirements.list({ projectId, limit: ROWS }),
				client.risks.list({ projectId, limit: ROWS }),
				client.issues.list({ projectId, limit: ROWS }),
				client.procedures.list({ projectId, limit: ROWS }),
				client.datasets.list({ projectId, limit: ROWS }),
				executions
			])
		);
	return { project, requirements, risks, issues, procedures, datasets, executions: executionList };
};
