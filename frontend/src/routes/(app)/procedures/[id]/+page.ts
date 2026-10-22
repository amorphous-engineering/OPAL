import { error } from '@sveltejs/kit';
import { api, ApiError, type Page } from '#lib/api.js';
import type {
	ExecutionRow,
	IssueRow,
	KitLine,
	OutputLine,
	ProcedureDetail,
	RefDoc,
	VersionRow
} from '#lib/components/procedures/types.js';
import type { PageLoad } from './$types';

export const load: PageLoad = async ({ params, fetch }) => {
	const c = api.using(fetch);
	const id = params.id;
	try {
		const [procedure, versions, kit, outputs, executions, issues, docs] = await Promise.all([
			c.get<ProcedureDetail>(`/procedures/${id}`),
			c.get<VersionRow[]>(`/procedures/${id}/versions`),
			c.get<KitLine[]>(`/procedures/${id}/kit`),
			c.get<OutputLine[]>(`/procedures/${id}/outputs`),
			c.get<Page<ExecutionRow>>('/procedure-instances', { procedure_id: id, page_size: 10 }),
			c.get<Page<IssueRow>>('/issues', { procedure_id: id, status: 'open', page_size: 10 }),
			c.get<RefDoc[]>('/attachments', { procedure_id: id, kind: 'reference' })
		]);
		return { procedure, versions, kit, outputs, executions, issues, docs };
	} catch (e) {
		if (e instanceof ApiError) error(e.status, e.message);
		throw e;
	}
};
