import { contracts } from '@opal/shared';
import { ne } from 'drizzle-orm';
import { risk } from '../db/schema/index.ts';
import { type Impl, implement } from '../registry.ts';
import { issueHooks } from '../services/issues/hooks.ts';
import { registerEntity, registerSearchable } from '../services/platform/index.ts';
import * as dispositions from '../services/risks/dispositions.ts';
import * as links from '../services/risks/links.ts';
import { lintScenario, lintSegments, SCENARIO_FIELDS } from '../services/risks/lint.ts';
import * as risks from '../services/risks/service.ts';

const c = contracts.risks;

registerEntity(risk, {
	label: 'Risk',
	ref: (r) => ({ label: r.riskNumber, href: `/risks/${r.id}` })
});
registerSearchable({
	type: 'risk',
	table: risk,
	columns: [risk.title, risk.description],
	identifier: risk.riskNumber,
	where: ne(risk.disposition, 'closed'),
	hit: (r) => ({
		label: r.title,
		sublabel: r.riskNumber,
		href: `/risks/${r.id}`,
		status: r.disposition
	})
});

// The issue page lists the risks an issue responds to or realizes.
issueHooks.linkedRisks = links.risksOfIssue;

// Static paths come before `/risks/:id` so they are never read as an id.
export const risksImpls = [
	implement(c.matrix, (ctx, input) => risks.matrix(ctx, input.projectId)),
	implement(c.lint, (_ctx, input) => {
		const findings = lintScenario(input);
		const empty = () => ({ condition: [], departure: [], consequence: [] });
		const segments: Record<string, ReturnType<typeof lintSegments>> = empty();
		for (const f of SCENARIO_FIELDS) segments[f] = lintSegments(input[f] ?? '', findings[f]);
		return {
			findings,
			segments: segments as ReturnType<typeof empty>,
			wouldBlockAccept: Object.values(findings)
				.flat()
				.some((f) => f.severity === 'block_accept')
		};
	}),
	implement(c.reviewStamp, (ctx, input) => risks.reviewStamp(ctx, input)),
	implement(c.list, (ctx, input) => risks.list(ctx, input)),
	implement(c.create, (ctx, input) => risks.create(ctx, input)),
	implement(c.get, (ctx, input) => risks.get(ctx, input.id)),
	implement(c.update, (ctx, input) => risks.updateRisk(ctx, input)),
	implement(c.delete, (ctx, input) => risks.deleteRisk(ctx, input.id)),
	implement(c.readiness, (ctx, input) => dispositions.readiness(ctx, input.id)),
	implement(c.dispositionCheck, (ctx, input) =>
		dispositions.dispositionCheck(ctx, input.id, input.target)
	),
	implement(c.history, (ctx, input) => risks.history(ctx, input.id)),
	implement(c.setDisposition, (ctx, input) => dispositions.setDisposition(ctx, input.id, input)),
	implement(c.accept, (ctx, input) => dispositions.accept(ctx, input.id, input.rationale)),
	implement(c.spawnIssue, (ctx, input) => links.spawnIssue(ctx, input.id, input)),
	implement(c.linkIssue, (ctx, input) => links.linkIssue(ctx, input.id, input.issueId, input.role)),
	implement(c.unlinkIssue, (ctx, input) => links.unlinkIssue(ctx, input.id, input.issueId)),
	implement(c.addReference, (ctx, input) => links.addReference(ctx, input.id, input)),
	implement(c.removeReference, (ctx, input) => links.removeReference(ctx, input.id, input.referenceId))
] as Impl[];
