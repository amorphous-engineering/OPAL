import { opal } from '#lib/api.js';
import type { PageLoad } from './$types';

/** A record the invoking page already knows about (voice rule 6). */
export interface Ctx {
	id: number;
	label: string;
	sub?: string | null;
}

/**
 * Context pre-fill from the query string: ?part=, ?execution= with ?executionLabel=,
 * ?step= (a step execution on that execution) with ?stepLabel=, plus ?type=,
 * ?containment=, ?title=. The invoking page passes the labels it already shows.
 */
export const load: PageLoad = async ({ fetch, url }) => {
	const q = url.searchParams;
	const client = opal.using(fetch);
	const num = (k: string) => {
		const v = Number(q.get(k));
		return Number.isInteger(v) && v > 0 ? v : null;
	};
	const partId = num('part');
	const executionId = num('execution');
	const stepId = num('step');

	const [part, assignees] = await Promise.all([
		partId ? client.parts.get({ id: partId }).catch(() => null) : null,
		client.issues.assignees({})
	]);

	const ctx = {
		part: part ? ({ id: part.id, label: part.name, sub: part.internalPn } as Ctx) : null,
		execution: executionId
			? ({ id: executionId, label: q.get('executionLabel') || 'Work order' } as Ctx)
			: null,
		step: stepId && executionId
			? ({ id: stepId, label: q.get('stepLabel') || 'Step' } as Ctx)
			: null
	};
	return {
		ctx,
		assignees,
		defaults: {
			title: q.get('title') ?? '',
			type: q.get('type') ?? (ctx.step ? 'non_conformance' : 'task'),
			containment: q.get('containment') ?? (ctx.step ? 'step' : 'advisory')
		}
	};
};
