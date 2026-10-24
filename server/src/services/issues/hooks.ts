/**
 * Seams to areas that arrive later, and the one notification function.
 *
 * Every issue notification goes through `notify()` below. It computes recipients and text, then
 * calls `issueHooks.deliver`, which stores them through the platform area's `notify`.
 * Tests replace `deliver` to capture what would be sent.
 */
import type { Ctx } from '../../context.ts';
import { actorUserId } from '../../context.ts';
import { notify as platformNotify } from '../platform/index.ts';
import type { ExecutionRef, LinkedRisk, RedlineOp, StepOption } from '@opal/shared';
import type { IssueRow } from './state.ts';

export type NotificationKind =
	| 'issue_assigned'
	| 'issue_dispositioned'
	| 'issue_commented'
	| 'issue_closed';

export interface IssueNotification {
	kind: NotificationKind;
	/** Users to tell. The actor is already removed. */
	recipients: number[];
	title: string;
	body: string | null;
	href: string;
	subjectType: 'issue';
	subjectId: number;
	priority: 'low' | 'normal' | 'high' | 'critical';
}

export interface HoldChange {
	executionId: number;
	wasBlocking: boolean;
	isBlocking: boolean;
	issue: IssueRow;
}

export interface IssueHooks {
	/** Store the notification for each recipient. Null drops them. */
	deliver: ((ctx: Ctx, n: IssueNotification) => void) | null;
	/** Execution area: the step's execution, or null when the step does not exist. */
	resolveStep: ((ctx: Ctx, stepId: number) => { executionId: number } | null) | null;
	/** Execution area: whether an execution exists. */
	executionExists: ((ctx: Ctx, executionId: number) => boolean) | null;
	/** Execution area: labels for the executions and steps issues point at. */
	describe:
		| ((
				ctx: Ctx,
				q: { executionIds: number[]; stepIds: number[] }
		  ) => { executions: Map<number, ExecutionRef>; steps: Map<number, string> })
		| null;
	/** Execution area: steps of an execution, as boundary candidates. */
	stepOptions: ((ctx: Ctx, executionId: number) => StepOption[]) | null;
	/** Risks and execution area: what an issue touches (linked risks, redline ops). */
	detailExtras:
		| ((
				ctx: Ctx,
				issue: IssueRow
		  ) => { raisedOpOrder: number | null; risks: LinkedRisk[]; redlineOps: RedlineOp[] })
		| null;
	/** Risks area: the risks an issue responds to or realizes. Added to `detailExtras.risks`. */
	linkedRisks: ((ctx: Ctx, issueId: number) => LinkedRisk[]) | null; // added by risks
	/**
	 * Execution area: called after a change that could hold or release an execution. The area
	 * rechecks completion and sends blocked and unblocked notices when the answer changed.
	 */
	holdChanged: ((ctx: Ctx, change: HoldChange) => void)[];
}

export const platformDeliver = (ctx: Ctx, n: IssueNotification): void => {
	platformNotify(ctx, {
		recipients: n.recipients,
		kind: n.kind,
		title: n.title,
		body: n.body,
		href: n.href,
		subjectType: n.subjectType,
		subjectId: n.subjectId,
		priority: n.priority
	});
};

export const issueHooks: IssueHooks = {
	deliver: platformDeliver,
	resolveStep: null,
	executionExists: null,
	describe: null,
	stepOptions: null,
	detailExtras: null,
	linkedRisks: null, // added by risks
	holdChanged: []
};

const PRIORITY = { critical: 'critical', high: 'high', medium: 'normal', low: 'low' } as const;

/** People with a standing interest in an issue: its assignee and its raiser. */
const audience = (i: IssueRow) =>
	[i.assignedToId, i.raisedById].filter((u): u is number => u !== null);

export function notify(
	ctx: Ctx,
	kind: NotificationKind,
	i: IssueRow,
	extra: { actorName?: string; excerpt?: string } = {}
): void {
	if (!issueHooks.deliver) return;
	const actor = actorUserId(ctx.actor);
	const base = { href: `/issues/${i.id}`, subjectType: 'issue', subjectId: i.id } as const;
	const priority = PRIORITY[i.priority];
	const make = (
		recipients: (number | null)[],
		title: string,
		body: string | null,
		prio: IssueNotification['priority'] = priority
	) => {
		const to = [...new Set(recipients.filter((u): u is number => u !== null && u !== actor))];
		if (to.length) issueHooks.deliver!(ctx, { kind, recipients: to, title, body, priority: prio, ...base });
	};
	switch (kind) {
		case 'issue_assigned':
			return make([i.assignedToId], `${i.issueNumber} assigned to you`, i.title);
		case 'issue_dispositioned':
			return make(
				audience(i),
				`${i.issueNumber} dispositioned ${(i.dispositionType ?? 'signed').replaceAll('_', ' ')}`,
				i.title
			);
		case 'issue_commented':
			return make(
				audience(i),
				`${extra.actorName ?? 'Someone'} commented on ${i.issueNumber}`,
				extra.excerpt ?? null
			);
		case 'issue_closed':
			return make(audience(i), `${i.issueNumber} closed`, i.title, 'normal');
	}
}

export function excerpt(body: string): string {
	const flat = body.trim().replaceAll('\n', ' ');
	return flat.length > 160 ? `${flat.slice(0, 157)}...` : flat;
}
