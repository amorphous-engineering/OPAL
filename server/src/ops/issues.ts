import { contracts } from '@opal/shared';
import { ne } from 'drizzle-orm';
import { issue, issueComment } from '../db/schema/index.ts';
import { type Impl, implement } from '../registry.ts';
import { registerEntity, registerSearchable } from '../services/platform/index.ts';
import * as issues from '../services/issues/service.ts';

const c = contracts.issues;

registerEntity(issue, {
	label: 'Issue',
	ref: (r) => ({ label: r.issueNumber, href: `/issues/${r.id}` })
});
registerEntity(issueComment, { label: 'Issue comment', parent: { table: issue, fk: 'issueId' } });
registerSearchable({
	type: 'issue',
	table: issue,
	columns: [issue.title, issue.description],
	identifier: issue.issueNumber,
	where: ne(issue.status, 'void'),
	hit: (r) => ({
		label: r.title,
		sublabel: r.issueNumber,
		href: `/issues/${r.id}`,
		status: r.status
	})
});

export const issuesImpls = [
	// Registered before issues.get so "assignees" is never read as an id.
	implement(c.assignees, (ctx) => issues.assignees(ctx)),
	implement(c.list, (ctx, input) => issues.list(ctx, input)),
	implement(c.get, (ctx, input) => issues.get(ctx, input.id)),
	implement(c.create, (ctx, input) => issues.create(ctx, input)),
	implement(c.update, (ctx, input) => issues.updateIssue(ctx, input)),
	implement(c.start, (ctx, input) => issues.startWork(ctx, input.id)),
	implement(c.review, (ctx, input) => issues.requestReview(ctx, input.id)),
	implement(c.returnFromReview, (ctx, input) => issues.returnFromReview(ctx, input.id, input.comment)),
	implement(c.signOff, (ctx, input) => issues.signOff(ctx, input.id)),
	implement(c.signDisposition, (ctx, input) =>
		issues.signDisposition(ctx, input.id, input.dispositionType, input.dispositionRationale)
	),
	implement(c.setContainment, (ctx, input) => issues.setContainment(ctx, input)),
	implement(c.void, (ctx, input) => issues.voidIssue(ctx, input.id, input.reason)),
	implement(c.steps, (ctx, input) => issues.steps(ctx, input.id)),
	implement(c.holding, (ctx, input) => issues.holding(ctx, input.id, input.containment)),
	implement(c.listComments, (ctx, input) => issues.listComments(ctx, input.id)),
	implement(c.addComment, (ctx, input) => issues.addComment(ctx, input.id, input.body)),
	implement(c.addLink, (ctx, input) => issues.addLink(ctx, input.id, input.kind, input.targetId)),
	implement(c.removeLink, (ctx, input) => issues.removeLink(ctx, input.id, input.linkId))
] as Impl[];
