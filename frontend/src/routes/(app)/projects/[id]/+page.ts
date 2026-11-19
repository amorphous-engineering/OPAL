import { opal, orHttpError } from '#lib/api.js';
import type { PageLoad } from './$types';

const ROWS = 10;

export const load: PageLoad = async ({ fetch, params }) => {
	const client = opal.using(fetch);
	const projectId = Number(params.id);
	// added by execution: a failed list leaves the section out
	const executions = client.execution.list({ projectId, limit: ROWS }).catch(() => null);
	// The project's own roles, with the people who hold them. A failed list leaves the section out.
	const roles = Promise.all([client.org.roles.list({}), client.org.users.directory({})]).catch(
		() => null
	);
	const [project, requirements, risks, issues, procedures, datasets, executionList, roleData] =
		await orHttpError(
			Promise.all([
				client.org.projects.get({ id: projectId }),
				client.requirements.list({ projectId, limit: ROWS }),
				client.risks.list({ projectId, limit: ROWS }),
				client.issues.list({ projectId, limit: ROWS }),
				client.procedures.list({ projectId, limit: ROWS }),
				client.datasets.list({ projectId, limit: ROWS }),
				executions,
				roles
			])
		);
	return {
		project,
		requirements,
		risks,
		issues,
		procedures,
		datasets,
		executions: executionList,
		roles: roleData?.[0] ?? null,
		people: roleData?.[1] ?? []
	};
};
