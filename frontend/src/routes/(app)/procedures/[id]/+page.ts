import { opal, orHttpError } from '#lib/api.js';
import type { TemplateData } from '#lib/components/procedures/template-data.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, fetch }) => {
	const c = opal.using(fetch);
	const id = Number(params.id);
	const [procedure, versions, kit, outputs, docs, runs, open] = await orHttpError(
		Promise.all([
			c.procedures.get({ id }),
			c.procedures.versions.list({ id }),
			c.procedures.kit.list({ id }),
			c.procedures.outputs.list({ id }),
			c.platform.attachments.list({ ownerType: 'procedure', ownerId: id, kind: 'reference' }),
			c.execution.list({ procedureId: id, limit: 8 }), // added by execution
			c.issues.list({ procedureId: id, status: 'open', limit: 8 }) // added by execution
		])
	);
	const executions: TemplateData['executions'] = {
		items: runs.items.map((r) => ({
			id: r.id,
			workOrderNumber: r.woNumber,
			versionNumber: r.versionNumber,
			status: r.status
		})),
		total: runs.total
	};
	const issues: TemplateData['issues'] = { items: open.items, total: open.total };
	const data: TemplateData = { procedure, versions, kit, outputs, executions, issues, docs };
	return data;
};
