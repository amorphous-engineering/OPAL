/** Raise a non-conformance from a step. The invoking context supplies project, execution, step. */
import { OpalError } from '@opal/shared';
import type { Ctx } from '../../context.ts';
import { create as createIssue } from '../issues/service.ts';
import { getRow, loadModel } from './model.ts';

export function raiseNc(
	ctx: Ctx,
	input: {
		id: number;
		stepId: number;
		title: string;
		description?: string | null;
		priority: 'low' | 'medium' | 'high' | 'critical';
		shouldBe?: string | null;
		actual?: string | null;
		containment: 'advisory' | 'step' | 'op' | 'wo';
		containmentStepId?: number | null;
		assignedToId?: number | null;
	}
) {
	const m = loadModel(ctx.db, input.id);
	const row = getRow(m, input.stepId);
	if (input.containmentStepId != null && !m.byId.has(input.containmentStepId)) {
		throw new OpalError(404, 'not_found', `Boundary step ${input.containmentStepId} not found`);
	}
	const issue = createIssue(ctx, {
		projectId: m.exec.projectId,
		title: input.title,
		description: input.description ?? null,
		issueType: 'non_conformance',
		priority: input.priority,
		containment: input.containment,
		containmentStepId: input.containmentStepId ?? null,
		shouldBe: input.shouldBe ?? null,
		actual: input.actual ?? null,
		stepsToReproduce: null,
		expectedBehavior: null,
		actualBehavior: null,
		expectedBenefit: null,
		executionId: m.exec.id,
		raisedStepId: row.id,
		assignedToId: input.assignedToId ?? null,
		links: []
	} as Parameters<typeof createIssue>[1]);
	return {
		id: issue.id,
		issueNumber: issue.issueNumber,
		title: issue.title,
		containment: issue.containment,
		executionId: m.exec.id,
		stepId: row.id
	};
}
