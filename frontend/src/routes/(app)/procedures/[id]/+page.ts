import { opal, orHttpError } from '#lib/api.js';
import type { TemplateData } from '#lib/components/procedures/template-data.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, fetch }) => {
	const c = opal.using(fetch);
	const id = Number(params.id);
	const [procedure, versions, kit, outputs, docs] = await orHttpError(
		Promise.all([
			c.procedures.get({ id }),
			c.procedures.versions.list({ id }),
			c.procedures.kit.list({ id }),
			c.procedures.outputs.list({ id }),
			c.platform.attachments.list({ ownerType: 'procedure', ownerId: id, kind: 'reference' })
		])
	);
	// The execution list belongs to the execution area. Its list operation does not exist yet,
	// so the column is empty; the execution agent loads `opal.execution.list` here.
	const executions: TemplateData['executions'] = { items: [], total: 0 };
	// Issues have no procedure filter yet (issues area); the panel stays empty.
	const issues: TemplateData['issues'] = { items: [], total: 0 };
	const data: TemplateData = { procedure, versions, kit, outputs, executions, issues, docs };
	return data;
};
