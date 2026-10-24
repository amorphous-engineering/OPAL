import { opal, orHttpError } from '#lib/api.js';
import { contracts } from '@opal/shared';
import type { PageLoad } from './$types';

const ROWS = 10;

/** A list the execution area has not defined yet (or without a project filter) is absent. */
type ExecutionList = (i: {
	projectId: number;
	limit: number;
}) => Promise<{ items: Record<string, unknown>[]; next?: string | null; total?: number }>;

export const load: PageLoad = async ({ fetch, params }) => {
	const client = opal.using(fetch);
	const projectId = Number(params.id);
	const executions =
		'list' in contracts.execution
			? ((client as unknown as { execution: { list: ExecutionList } }).execution.list({
					projectId,
					limit: ROWS
				}) as Promise<Awaited<ReturnType<ExecutionList>>>).catch(() => null)
			: Promise.resolve(null);
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
