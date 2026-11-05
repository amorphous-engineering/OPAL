import { opal, orHttpError } from '#lib/api.js';
import type { TemplateData } from '#lib/components/procedures/template-data.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, fetch, url }) => {
	// Reading again after EDIT is DONE shows the draft as edited, so the mode is part of the load.
	void url.searchParams.get('edit');
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
	// Reading shows the release; a template with none is read from its draft.
	const [current, draft] = await orHttpError(
		Promise.all([
			procedure.currentVersionId === null
				? Promise.resolve(null)
				: c.procedures.versions.get({ versionId: procedure.currentVersionId }),
			procedure.currentVersionId === null ? c.procedures.draft({ id }) : Promise.resolve(null)
		])
	);
	const data: TemplateData = {
		procedure,
		versions,
		kit,
		outputs,
		executions,
		issues,
		docs,
		current,
		draftSteps: draft?.steps ?? null
	};
	return data;
};
