import { api } from '#lib/api.js';
import type { Assignee } from '#lib/components/issues/issues.js';
import type { PageLoad } from './$types';

/** A record the invoking page already knows about (voice rule 6). */
export interface Ctx {
	id: number;
	label: string;
	sub?: string | null;
}

interface PartDto {
	id: number;
	internal_pn: string | null;
	name: string;
}
interface ProcedureDto {
	id: number;
	name: string;
}
interface InstanceDto {
	id: number;
	procedure_id: number;
	procedure_name: string;
	work_order_number: string | null;
	step_executions: { id: number; step_number_str: string | null; step_number: number }[];
}

const orNull = <T>(p: Promise<T>) => p.catch(() => null);

/**
 * Context pre-fill from the query string: ?part=, ?procedure=, ?execution= (or the
 * older ?procedure_instance_id=), ?step= (a step execution on that execution),
 * plus ?type=, ?containment=, ?title=.
 */
export const load: PageLoad = async ({ fetch, url }) => {
	const q = url.searchParams;
	const client = api.using(fetch);
	const num = (k: string) => {
		const v = Number(q.get(k));
		return Number.isInteger(v) && v > 0 ? v : null;
	};
	const partId = num('part');
	const procedureId = num('procedure');
	const executionId = num('execution') ?? num('procedure_instance_id');
	const stepId = num('step');

	const [part, procedure, instance, assignees] = await Promise.all([
		partId ? orNull(client.get<PartDto>(`/parts/${partId}`)) : null,
		procedureId ? orNull(client.get<ProcedureDto>(`/procedures/${procedureId}`)) : null,
		executionId ? orNull(client.get<InstanceDto>(`/procedure-instances/${executionId}`)) : null,
		client.get<Assignee[]>('/issues/assignees')
	]);

	const step = instance?.step_executions.find((s) => s.id === stepId) ?? null;
	const ctx = {
		part: part ? ({ id: part.id, label: part.name, sub: part.internal_pn } as Ctx) : null,
		procedure: instance
			? ({ id: instance.procedure_id, label: instance.procedure_name } as Ctx)
			: procedure
				? ({ id: procedure.id, label: procedure.name } as Ctx)
				: null,
		execution: instance
			? ({ id: instance.id, label: instance.work_order_number ?? `Execution` } as Ctx)
			: null,
		step: step
			? ({ id: step.id, label: step.step_number_str ?? String(step.step_number) } as Ctx)
			: null
	};
	return {
		ctx,
		assignees,
		defaults: {
			title: q.get('title') ?? '',
			type: q.get('type') ?? (step ? 'non_conformance' : 'task'),
			containment: q.get('containment') ?? (step ? 'step' : 'advisory')
		}
	};
};
