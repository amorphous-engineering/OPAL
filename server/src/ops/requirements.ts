import { contracts } from '@opal/shared';
import { ne } from 'drizzle-orm';
import { baselineEvent, partRequirement, requirement } from '../db/schema/index.ts';
import { type Impl, implement } from '../registry.ts';
import { registerPartReference } from '../services/parts/references.ts';
import { registerEntity, registerSearchable } from '../services/platform/index.ts';
import * as svc from '../services/requirements/service.ts';

const c = contracts.requirements;

registerEntity(requirement, {
	label: 'Requirement',
	ref: (r) => ({ label: `${r.reqNumber} rev ${r.revision}`, href: `/requirements/${r.id}` })
});
registerEntity(baselineEvent, {
	label: 'Baseline event',
	ref: (r) => ({ label: r.label ?? `Baseline ${r.id}`, href: `/requirements/baselines/${r.id}` })
});
registerEntity(partRequirement, { label: 'Part requirement' });
registerSearchable({
	type: 'requirement',
	table: requirement,
	columns: [requirement.title, requirement.statement],
	identifier: requirement.reqNumber,
	where: ne(requirement.lifecycleState, 'superseded'),
	hit: (r) => ({
		label: r.title,
		sublabel: r.reqNumber,
		href: `/requirements/${r.id}`,
		status: r.lifecycleState
	})
});
registerPartReference({
	name: 'requirement_allocations',
	count: (ctx, partId) => svc.linkCount(ctx, partId)
});

export const requirementsImpls = [
	// Static paths first: a name is never read as an id.
	implement(c.lint, (ctx, input) => svc.lint(ctx, input)),
	implement(c.tree, (ctx, input) => svc.treeView(ctx, input.projectId)),
	implement(c.summary, (ctx, input) => svc.summaryView(ctx, input.projectId)),
	implement(c.queue, (ctx, input) => svc.queue(ctx, input.projectId)),
	implement(c.baselines, (ctx, input) => svc.baselines(ctx, input.projectId)),
	implement(c.baselineEvent, (ctx, input) => svc.baselineEventGet(ctx, input.id)),
	implement(c.baselineBatch, (ctx, input) => svc.baselineBatch(ctx, input)),
	implement(c.importCatalog, (ctx, input) => svc.importCatalog(ctx, input.projectId)),
	implement(c.catalog, (ctx) => svc.catalogPending(ctx)),
	implement(c.byNumber, (ctx, input) => svc.byNumber(ctx, input.reqNumber)),
	implement(c.forPart, (ctx, input) => svc.forPart(ctx, input.partId)),
	implement(c.assign, (ctx, input) => svc.assign(ctx, input)),
	implement(c.updateLink, (ctx, input) => svc.updateLink(ctx, input)),
	implement(c.verifyLink, (ctx, input) => svc.verifyLink(ctx, input)),
	implement(c.unassign, (ctx, input) => svc.unassign(ctx, input.id)),
	implement(c.list, (ctx, input) => svc.list(ctx, input)),
	implement(c.create, (ctx, input) => svc.create(ctx, input)),
	implement(c.get, (ctx, input) => svc.get(ctx, input.id)),
	implement(c.update, (ctx, input) => svc.updateRequirement(ctx, input)),
	implement(c.delete, (ctx, input) => svc.deleteRequirement(ctx, input.id)),
	implement(c.baseline, (ctx, input) => svc.baseline(ctx, input.id)),
	implement(c.revise, (ctx, input) => svc.revise(ctx, input.id)),
	implement(c.cancel, (ctx, input) => svc.cancel(ctx, input.id)),
	implement(c.reaffirm, (ctx, input) => svc.reaffirm(ctx, input.id)),
	implement(c.dossier, (ctx, input) => svc.dossierView(ctx, input.id)),
	implement(c.redline, (ctx, input) => svc.redlineView(ctx, input.id, input.revA, input.revB)),
	implement(c.readiness, (ctx, input) => svc.readinessView(ctx, input.id)),
	implement(c.revisions, (ctx, input) => svc.revisions(ctx, input.id))
] as Impl[];
