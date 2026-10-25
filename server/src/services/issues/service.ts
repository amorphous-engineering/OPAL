/** Issue business rules. Handlers in ops/issues.ts only call these. */
import {
	CONTAINMENT_RANK,
	type Containment,
	type DispositionType,
	type Issue,
	type IssueComment,
	type IssueDetail,
	type IssueLink,
	type IssueLinkKind,
	OpalError,
	TICKET_STATES,
	type TicketState,
	type UserRef,
	conflict,
	forbidden,
	notFound,
	now,
	type zIssueCreate,
	type zIssueUpdate
} from '@opal/shared';
import { type AnyColumn, and, asc, desc, eq, inArray, like, or, sql, type SQL } from 'drizzle-orm';
import { personRefs } from '../org/people.ts';
import type { z } from 'zod';
import { actorUserId, type Ctx } from '../../context.ts';
import { execution, issue, issueComment, issueLink, part, risk, user } from '../../db/schema/index.ts';
import { insert, remove, update as writeUpdate } from '../../write.ts';
import { nextDesignator } from '../designators.ts';
import { projectRefs, requireActiveProject } from '../org/projects.ts'; // added by projects
import { holdsGate } from '../org/gates.ts';
import { hasBlocker } from './holds.ts';
import { excerpt, issueHooks, notify } from './hooks.ts';
import {
	blockingSql,
	containmentBearing,
	dispState,
	dispStateSql,
	isBlocking,
	isDispositioned,
	type IssueRow,
	selfDispositioned,
	ticketState,
	ticketStateSql
} from './state.ts';

// ---- errors ----

/** The issue is in the wrong state for this action. */
const refuse = (message: string) => conflict('issue_state', message);
const invalid = (field: string, message: string) =>
	new OpalError(422, 'invalid_input', message, { [field]: message });

// ---- loading and output ----

export function load(ctx: Ctx, id: number): IssueRow {
	const row = ctx.db.select().from(issue).where(eq(issue.id, id)).get();
	if (!row) throw notFound('Issue');
	return row;
}

type LinkRow = {
	link: typeof issueLink.$inferSelect;
	part: typeof part.$inferSelect | null;
	risk: typeof risk.$inferSelect | null; // added by risks
};

function toLink(r: LinkRow): IssueLink {
	// Each target kind adds its branch here.
	if (r.risk) {
		// added by risks
		return {
			id: r.link.id,
			kind: 'risk',
			targetId: r.risk.id,
			label: r.risk.riskNumber,
			sublabel: r.risk.title,
			href: `/risks/${r.risk.id}`
		};
	}
	const p = r.part!;
	return {
		id: r.link.id,
		kind: 'part',
		targetId: p.id,
		label: p.internalPn,
		sublabel: p.name,
		href: `/parts/${p.id}`
	};
}

function linksFor(ctx: Ctx, issueIds: number[]): Map<number, IssueLink[]> {
	const out = new Map<number, IssueLink[]>();
	if (!issueIds.length) return out;
	const rows = ctx.db
		.select({ link: issueLink, part, risk })
		.from(issueLink)
		.leftJoin(part, eq(part.id, issueLink.partId))
		.leftJoin(risk, eq(risk.id, issueLink.riskId)) // added by risks
		.where(inArray(issueLink.issueId, issueIds))
		.orderBy(asc(issueLink.id))
		.all();
	for (const r of rows) {
		const list = out.get(r.link.issueId) ?? [];
		list.push(toLink(r));
		out.set(r.link.issueId, list);
	}
	return out;
}

function hydrate(ctx: Ctx, rows: IssueRow[]): Issue[] {
	const projects = projectRefs(ctx.db, rows.map((r) => r.projectId)); // added by projects
	const userIds = new Set<number>();
	for (const r of rows) {
		for (const u of [
			r.dispositionedById,
			r.workStartedById,
			r.reviewRequestedById,
			r.closedById,
			r.raisedById,
			r.assignedToId
		])
			if (u !== null) userIds.add(u);
	}
	const names: Map<number, UserRef> = personRefs(ctx.db, userIds);
	const ref = (id: number | null) => (id === null ? null : (names.get(id) ?? null));
	const links = linksFor(ctx, rows.map((r) => r.id));
	const described = issueHooks.describe?.(ctx, {
		executionIds: [...new Set(rows.map((r) => r.executionId).filter((x): x is number => x !== null))],
		stepIds: [
			...new Set(
				rows.flatMap((r) => [r.raisedStepId, r.containmentStepId]).filter((x): x is number => x !== null)
			)
		]
	});
	const stepLabel = (id: number | null) => (id === null ? null : (described?.steps.get(id) ?? null));
	return rows.map((r) => ({
		id: r.id,
		issueNumber: r.issueNumber,
		projectId: r.projectId, // added by projects
		projectCode: projects.get(r.projectId)?.code ?? '', // added by projects
		projectName: projects.get(r.projectId)?.name ?? '', // added by projects
		title: r.title,
		description: r.description,
		issueType: r.issueType,
		status: r.status,
		priority: r.priority,
		containment: r.containment,
		containmentStepId: r.containmentStepId,
		executionId: r.executionId,
		execution:
			r.executionId === null
				? null
				: (described?.executions.get(r.executionId) ?? {
						id: r.executionId,
						label: null,
						procedureId: null,
						procedureName: null
					}),
		raisedStepId: r.raisedStepId,
		raisedStepLabel: stepLabel(r.raisedStepId),
		containmentStepLabel: stepLabel(r.containmentStepId),
		dispState: dispState(r),
		dispositioned: isDispositioned(r),
		ticketState: ticketState(r),
		isBlocking: isBlocking(r),
		selfDispositioned: selfDispositioned(r),
		shouldBe: r.shouldBe,
		actual: r.actual,
		stepsToReproduce: r.stepsToReproduce,
		expectedBehavior: r.expectedBehavior,
		actualBehavior: r.actualBehavior,
		expectedBenefit: r.expectedBenefit,
		rootCause: r.rootCause,
		correctiveAction: r.correctiveAction,
		dispositionType: r.dispositionType,
		dispositionRationale: r.dispositionRationale,
		dispositionedAt: r.dispositionedAt,
		dispositionedBy: ref(r.dispositionedById),
		workStartedAt: r.workStartedAt,
		workStartedBy: ref(r.workStartedById),
		reviewRequestedAt: r.reviewRequestedAt,
		reviewRequestedBy: ref(r.reviewRequestedById),
		closedAt: r.closedAt,
		closedBy: ref(r.closedById),
		raisedBy: ref(r.raisedById),
		assignedTo: ref(r.assignedToId),
		links: links.get(r.id) ?? [],
		createdAt: r.createdAt,
		updatedAt: r.updatedAt
	}));
}

const one = (ctx: Ctx, id: number): Issue => hydrate(ctx, [load(ctx, id)])[0]!;

// ---- gates ----

const GATE_REASON = {
	disposition: 'Requires the issue disposition permission',
	approve: 'Requires the issue approval permission'
};

export function get(ctx: Ctx, id: number): IssueDetail {
	const row = load(ctx, id);
	const base = hydrate(ctx, [row])[0]!;
	const extras = issueHooks.detailExtras?.(ctx, row) ?? { raisedOpOrder: null, risks: [], redlineOps: [] };
	extras.risks = [...extras.risks, ...(issueHooks.linkedRisks?.(ctx, row.id) ?? [])]; // added by risks
	const canDisposition = holdsGate(ctx.db, ctx.actor, 'issue.disposition');
	const canApprove = holdsGate(ctx.db, ctx.actor, 'issue.approve');
	return {
		...base,
		...extras,
		canDisposition,
		canApprove,
		gateReasons: {
			...(canDisposition ? {} : { disposition: GATE_REASON.disposition }),
			...(canApprove ? {} : { approve: GATE_REASON.approve })
		}
	};
}

// ---- list ----

export function list(
	ctx: Ctx,
	input: {
		cursor?: string;
		limit: number;
		q?: string;
		projectId?: number; // added by projects
		issueType?: IssueRow['issueType'];
		status?: IssueRow['status'];
		dispState?: Parameters<typeof dispStateSql>[0];
		state?: string;
		priority?: IssueRow['priority'];
		assignedToId?: number;
		partId?: number;
		executionId?: number;
		procedureId?: number; // added by execution
		sort?: 'number' | 'title' | 'type' | 'state' | 'priority' | 'created' | 'updated';
		dir: 'asc' | 'desc';
	}
) {
	let states: TicketState[] | undefined;
	if (input.state) {
		const wanted = [...new Set(input.state.split(',').map((s) => s.trim()).filter(Boolean))];
		const bad = wanted.filter((s) => !(TICKET_STATES as readonly string[]).includes(s));
		if (bad.length) throw invalid('state', `Invalid state: ${bad.sort().join(', ')}`);
		states = wanted as TicketState[];
	}
	const like_ = input.q ? `%${input.q}%` : undefined;
	const where = and(
		like_ ? or(like(issue.title, like_), like(issue.issueNumber, like_)) : undefined,
		input.projectId ? eq(issue.projectId, input.projectId) : undefined, // added by projects
		input.assignedToId ? eq(issue.assignedToId, input.assignedToId) : undefined,
		input.issueType ? eq(issue.issueType, input.issueType) : undefined,
		input.status ? eq(issue.status, input.status) : undefined,
		input.dispState ? dispStateSql(input.dispState) : undefined,
		states ? or(...states.map(ticketStateSql)) : undefined,
		input.priority ? eq(issue.priority, input.priority) : undefined,
		input.executionId ? eq(issue.executionId, input.executionId) : undefined,
		// added by execution: issues on executions of one procedure
		input.procedureId
			? inArray(
					issue.executionId,
					ctx.db.select({ id: execution.id }).from(execution).where(eq(execution.procedureId, input.procedureId))
				)
			: undefined,
		input.partId
			? inArray(
					issue.id,
					ctx.db
						.select({ id: issueLink.issueId })
						.from(issueLink)
						.where(eq(issueLink.partId, input.partId))
				)
			: undefined
	);
	const total = ctx.db.select({ n: sql<number>`count(*)` }).from(issue).where(where).get()!.n;

	const priorityRank = sql`CASE ${issue.priority} WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END`;
	const sortColumns: Record<NonNullable<typeof input.sort>, SQL | AnyColumn> = {
		number: issue.issueNumber,
		title: issue.title,
		type: issue.issueType,
		created: issue.createdAt,
		updated: issue.updatedAt,
		priority: priorityRank,
		state: sql`CASE WHEN ${blockingSql} THEN 0 WHEN ${issue.status} = 'open' THEN 1 ELSE 2 END`
	};
	const order = input.sort
		? [(input.dir === 'asc' ? asc : desc)(sortColumns[input.sort]), desc(issue.id)]
		: [sql`CASE WHEN ${blockingSql} THEN 0 ELSE 1 END`, desc(issue.id)];

	// The cursor is the offset: the order can be any column, so there is no key to seek on.
	const offset = Math.max(0, Number(input.cursor) || 0);
	const rows = ctx.db
		.select()
		.from(issue)
		.where(where)
		.orderBy(...order)
		.limit(input.limit + 1)
		.offset(offset)
		.all();
	const page = rows.slice(0, input.limit);
	return {
		items: hydrate(ctx, page),
		next: rows.length > input.limit ? String(offset + input.limit) : null,
		total
	};
}

export function assignees(ctx: Ctx): UserRef[] {
	const ids = ctx.db
		.select({ id: user.id })
		.from(user)
		.where(eq(user.isActive, true))
		.orderBy(asc(user.name))
		.all()
		.map((u) => u.id);
	const people = personRefs(ctx.db, ids);
	return ids.flatMap((id) => people.get(id) ?? []);
}

// ---- checks shared by the writes ----

const userExists = (ctx: Ctx, id: number) =>
	ctx.db.select({ id: user.id }).from(user).where(eq(user.id, id)).get() !== undefined;

function checkAssignee(ctx: Ctx, id: number | null | undefined) {
	if (id != null && !userExists(ctx, id)) throw invalid('assignedToId', `User ${id} not found`);
}

function checkExecution(ctx: Ctx, id: number | null | undefined) {
	if (id != null && issueHooks.executionExists && !issueHooks.executionExists(ctx, id))
		throw invalid('executionId', `Work order ${id} not found`);
}

/**
 * Reconcile a containment-bearing issue's execution with its step anchors: derive the
 * execution from an anchor when unset, and reject an anchor from a different execution.
 * Without the execution area wired in, anchors are stored unchecked.
 */
function reconcileExecution(
	ctx: Ctx,
	executionId: number | null,
	anchors: { field: string; stepId: number | null | undefined }[]
): number | null {
	let resolved = executionId;
	if (!issueHooks.resolveStep) return resolved;
	for (const { field, stepId } of anchors) {
		if (stepId == null) continue;
		const step = issueHooks.resolveStep(ctx, stepId);
		if (!step) throw invalid(field, `Step ${stepId} not found`);
		if (resolved === null) resolved = step.executionId;
		else if (step.executionId !== resolved)
			throw invalid(field, `Step ${stepId} belongs to a different work order than the issue`);
	}
	return resolved;
}

/** Run a change, then tell the execution area if the hold on its execution changed. */
function watchHold<T>(ctx: Ctx, executionIds: (number | null)[], fn: () => T, row: () => IssueRow): T {
	const ids = [...new Set(executionIds.filter((e): e is number => e !== null))];
	const wasBlocking = new Map(ids.map((e) => [e, hasBlocker(ctx.db, e)]));
	const out = fn();
	const after = row();
	for (const e of new Set([...ids, ...(after.executionId !== null ? [after.executionId] : [])])) {
		const was = wasBlocking.get(e) ?? false;
		const is = hasBlocker(ctx.db, e);
		for (const h of issueHooks.holdChanged)
			h(ctx, { executionId: e, wasBlocking: was, isBlocking: is, issue: after });
	}
	return out;
}

const norm = (v: string | null | undefined) => (v == null || v.trim() === '' ? null : v);

// ---- create ----

export function create(ctx: Ctx, input: z.output<typeof zIssueCreate>): Issue {
	requireActiveProject(ctx.db, input.projectId); // added by projects
	checkAssignee(ctx, input.assignedToId);
	checkExecution(ctx, input.executionId);
	for (const l of input.links) checkLinkTarget(ctx, l.kind, l.targetId);

	// A non-advisory containment holds one execution through its anchor. Advisory holds nothing.
	const executionId =
		input.containment === 'advisory'
			? (input.executionId ?? null)
			: reconcileExecution(ctx, input.executionId ?? null, [
					{ field: 'containmentStepId', stepId: input.containmentStepId },
					{ field: 'raisedStepId', stepId: input.raisedStepId }
				]);

	let created!: IssueRow;
	watchHold(
		ctx,
		[executionId],
		() => {
			created = insert(ctx, issue, {
				issueNumber: nextDesignator(ctx, 'IT'),
				projectId: input.projectId, // added by projects
				title: input.title,
				description: norm(input.description),
				issueType: input.issueType,
				status: 'open',
				priority: input.priority,
				containment: input.containment,
				containmentStepId: input.containmentStepId ?? null,
				executionId,
				raisedStepId: input.raisedStepId ?? null,
				shouldBe: norm(input.shouldBe),
				actual: norm(input.actual),
				stepsToReproduce: norm(input.stepsToReproduce),
				expectedBehavior: norm(input.expectedBehavior),
				actualBehavior: norm(input.actualBehavior),
				expectedBenefit: norm(input.expectedBenefit),
				raisedById: actorUserId(ctx.actor),
				assignedToId: input.assignedToId ?? null
			});
			for (const l of input.links) insertLink(ctx, created.id, l.kind, l.targetId);
		},
		() => created
	);
	notify(ctx, 'issue_assigned', created);
	return one(ctx, created.id);
}

// ---- update ----

const TEXT_FIELDS = [
	'description',
	'shouldBe',
	'actual',
	'stepsToReproduce',
	'expectedBehavior',
	'actualBehavior',
	'expectedBenefit',
	'rootCause',
	'correctiveAction'
] as const;

/**
 * Closing rules. An undispositioned containment-bearing issue cannot close: disposition first.
 * A non-conformance also needs corrective action text, at any containment.
 */
export function validateClose(r: IssueRow): void {
	if (containmentBearing(r) && !isDispositioned(r))
		throw refuse(`${r.issueNumber} is undispositioned; sign a disposition before closing`);
	if (r.issueType === 'non_conformance' && !(r.correctiveAction ?? '').trim())
		throw refuse(
			`${r.issueNumber} is a non-conformance; corrective action is required to close`
		);
}

function requireApprove(ctx: Ctx) {
	if (ctx.actor.kind === 'token')
		throw forbidden('This action needs a signed-in person, not an API token');
	if (!holdsGate(ctx.db, ctx.actor, 'issue.approve')) throw forbidden(GATE_REASON.approve);
}

const assertNotVoid = (r: IssueRow) => {
	if (r.status === 'void') throw refuse(`${r.issueNumber} is void`);
};

export function updateIssue(ctx: Ctx, input: z.output<typeof zIssueUpdate>): Issue {
	const before = load(ctx, input.id);
	assertNotVoid(before);
	const patch: Partial<typeof issue.$inferInsert> = {};

	if (input.title !== undefined) patch.title = input.title;
	if (input.projectId !== undefined && input.projectId !== before.projectId) { // added by projects
		requireActiveProject(ctx.db, input.projectId);
		patch.projectId = input.projectId;
	}
	if (input.issueType !== undefined) patch.issueType = input.issueType;
	if (input.priority !== undefined) patch.priority = input.priority;
	for (const f of TEXT_FIELDS) if (input[f] !== undefined) patch[f] = norm(input[f]);

	if (input.dispositionType !== undefined || input.dispositionRationale !== undefined) {
		// Drafting the panel is an edit. A signed disposition is immutable: a different
		// decision is a new signature, not an edit.
		if (isDispositioned(before)) throw refuse('Disposition already signed; it cannot be edited');
		if (input.dispositionType !== undefined) patch.dispositionType = input.dispositionType;
		if (input.dispositionRationale !== undefined)
			patch.dispositionRationale = norm(input.dispositionRationale);
	}

	if (input.assignedToId !== undefined) {
		checkAssignee(ctx, input.assignedToId);
		patch.assignedToId = input.assignedToId;
	}

	if (input.executionId !== undefined && input.executionId !== before.executionId) {
		if (input.executionId === null) {
			if (isBlocking(before))
				throw refuse(
					`${before.issueNumber} is undispositioned; sign a disposition before detaching its work order`
				);
		} else {
			checkExecution(ctx, input.executionId);
		}
		// A step anchor must not stay behind in the old work order.
		if (issueHooks.resolveStep) {
			for (const stepId of [before.containmentStepId, before.raisedStepId]) {
				if (stepId === null) continue;
				const step = issueHooks.resolveStep(ctx, stepId);
				if (step && step.executionId !== input.executionId)
					throw refuse('A step anchor belongs to the current work order; clear the boundary first');
			}
		}
		patch.executionId = input.executionId;
	}

	let closing = false;
	if (input.status === 'closed' && before.status !== 'closed') {
		requireApprove(ctx);
		validateClose({ ...before, ...patch } as IssueRow);
		Object.assign(patch, { status: 'closed', closedAt: now(), closedById: actorUserId(ctx.actor) });
		closing = true;
	} else if (input.status === 'open' && before.status === 'closed') {
		// Reopen: clear the stamps so the state derives again.
		Object.assign(patch, {
			status: 'open',
			closedAt: null,
			closedById: null,
			reviewRequestedAt: null,
			reviewRequestedById: null
		});
	}

	if (!Object.keys(patch).length) return one(ctx, before.id);
	let after!: IssueRow;
	watchHold(
		ctx,
		[before.executionId],
		() => {
			after = writeUpdate(ctx, issue, before.id, patch);
		},
		() => after
	);
	if (after.assignedToId !== null && after.assignedToId !== before.assignedToId)
		notify(ctx, 'issue_assigned', after);
	if (closing) notify(ctx, 'issue_closed', after);
	return one(ctx, after.id);
}

// ---- ticket flow: pending -> in work -> in review -> done ----

function requireState(r: IssueRow, state: TicketState, action: string) {
	const now_ = ticketState(r);
	if (now_ !== state) throw refuse(`${r.issueNumber} is ${now_.replace('_', ' ')}; cannot ${action}`);
}

/** Advisory issue: pending to in work. Containment-bearing issues enter work by disposition. */
export function startWork(ctx: Ctx, id: number): Issue {
	const r = load(ctx, id);
	if (containmentBearing(r))
		throw refuse(`${r.issueNumber} holds work; sign its disposition to start work`);
	requireState(r, 'pending', 'start work');
	writeUpdate(ctx, issue, id, { workStartedAt: now(), workStartedById: actorUserId(ctx.actor) });
	return one(ctx, id);
}

export function requestReview(ctx: Ctx, id: number): Issue {
	const r = load(ctx, id);
	requireState(r, 'in_work', 'submit for review');
	writeUpdate(ctx, issue, id, {
		reviewRequestedAt: now(),
		reviewRequestedById: actorUserId(ctx.actor)
	});
	return one(ctx, id);
}

export function returnFromReview(ctx: Ctx, id: number, comment: string): Issue {
	const r = load(ctx, id);
	requireState(r, 'in_review', 'return from review');
	if (!comment.trim()) throw refuse('A comment is required to return an issue');
	writeUpdate(ctx, issue, id, { reviewRequestedAt: null, reviewRequestedById: null });
	const note = addNote(ctx, r, `Returned from review: ${comment.trim()}`);
	notifyComment(ctx, r, note.body);
	return one(ctx, id);
}

/** In review to done, under the closing rules. The contract holds the issue.approve gate. */
export function signOff(ctx: Ctx, id: number): Issue {
	const r = load(ctx, id);
	requireState(r, 'in_review', 'sign off');
	validateClose(r);
	let after!: IssueRow;
	watchHold(
		ctx,
		[r.executionId],
		() => {
			after = writeUpdate(ctx, issue, id, {
				status: 'closed',
				closedAt: now(),
				closedById: actorUserId(ctx.actor)
			});
		},
		() => after
	);
	notify(ctx, 'issue_closed', after);
	return one(ctx, id);
}

// ---- disposition ----

/** Sign the disposition. The contract holds the issue.disposition gate. */
export function signDisposition(
	ctx: Ctx,
	id: number,
	type: DispositionType,
	rationale: string
): Issue {
	const r = load(ctx, id);
	if (r.status === 'closed') throw refuse('Issue is closed');
	if (r.status === 'void') throw refuse('Issue is void');
	if (isDispositioned(r)) throw refuse('Disposition already signed');
	if (!containmentBearing(r))
		throw refuse(`${r.issueNumber} is advisory; there is no disposition to sign`);
	let after!: IssueRow;
	watchHold(
		ctx,
		[r.executionId],
		() => {
			after = writeUpdate(ctx, issue, id, {
				dispositionType: type,
				dispositionRationale: rationale,
				dispositionedById: actorUserId(ctx.actor),
				dispositionedAt: now()
			});
		},
		() => after
	);
	notify(ctx, 'issue_dispositioned', after);
	return one(ctx, id);
}

// ---- containment ----

export function setContainment(
	ctx: Ctx,
	input: {
		id: number;
		containment: Containment;
		containmentStepId?: number | null;
		note?: string | null;
	}
): Issue {
	const r = load(ctx, input.id);
	assertNotVoid(r);
	const note = (input.note ?? '').trim();
	const narrowing = CONTAINMENT_RANK[input.containment] < CONTAINMENT_RANK[r.containment];
	if (narrowing && isBlocking(r) && !note)
		throw refuse(
			`Narrowing containment ${r.containment} → ${input.containment} releases a hold; a note is required`
		);

	const patch: Partial<typeof issue.$inferInsert> = { containment: input.containment };
	// Absent keeps the boundary; an explicit null clears it. A boundary must belong to this
	// issue's work order, and it seeds the work order of a still-unlinked issue.
	if (input.containmentStepId !== undefined) {
		if (input.containmentStepId !== null && issueHooks.resolveStep) {
			const step = issueHooks.resolveStep(ctx, input.containmentStepId);
			if (!step) throw notFound('Step');
			if (r.executionId === null) patch.executionId = step.executionId;
			else if (step.executionId !== r.executionId)
				throw refuse(
					`Step ${input.containmentStepId} belongs to a different work order than this issue`
				);
		}
		patch.containmentStepId = input.containmentStepId;
	}

	let after!: IssueRow;
	watchHold(
		ctx,
		[r.executionId],
		() => {
			after = writeUpdate(ctx, issue, r.id, patch);
			if (narrowing && note)
				addNote(ctx, r, `Containment narrowed ${r.containment} → ${input.containment}: ${note}`);
		},
		() => after
	);
	return one(ctx, r.id);
}

// ---- void ----

export function voidIssue(ctx: Ctx, id: number, reason: string): Issue {
	const r = load(ctx, id);
	assertNotVoid(r);
	let after!: IssueRow;
	watchHold(
		ctx,
		[r.executionId],
		() => {
			after = writeUpdate(ctx, issue, id, { status: 'void' });
			addNote(ctx, r, `Voided: ${reason}`);
		},
		() => after
	);
	return one(ctx, id);
}

// ---- steps and holding ----

/** Steps of the issue work order, for choosing a containment boundary. */
export function steps(ctx: Ctx, id: number) {
	const r = load(ctx, id);
	if (r.executionId === null || !issueHooks.stepOptions) return [];
	return issueHooks.stepOptions(ctx, r.executionId);
}

export function holding(ctx: Ctx, id: number, containment?: Containment) {
	const r = load(ctx, id);
	let scope: Containment;
	if (containment === undefined) {
		if (!isBlocking(r)) return [];
		scope = r.containment;
	} else {
		// A preview of a proposed scope: only an undispositioned issue holds anything.
		if (dispState(r) !== 'undispositioned' || containment === 'advisory') return [];
		scope = containment;
	}
	if (r.executionId === null || scope === 'advisory') return [];
	const stepId = scope === 'wo' ? null : (r.containmentStepId ?? r.raisedStepId);
	const labels = issueHooks.describe?.(ctx, {
		executionIds: [r.executionId],
		stepIds: stepId === null ? [] : [stepId]
	});
	const wo = labels?.executions.get(r.executionId)?.label ?? 'WO';
	const step = stepId === null ? null : (labels?.steps.get(stepId) ?? 'STEP');
	const label = scope === 'wo' ? wo : scope === 'op' ? `OP ${step}` : step;
	return [
		{
			scope,
			executionId: r.executionId,
			stepId,
			label: `${label} COMPLETE`,
			href: `/executions/${r.executionId}`
		}
	];
}

// ---- comments ----

function addNote(ctx: Ctx, r: IssueRow, body: string) {
	return insert(ctx, issueComment, { issueId: r.id, userId: actorUserId(ctx.actor), body });
}

function notifyComment(ctx: Ctx, r: IssueRow, body: string) {
	const uid = actorUserId(ctx.actor);
	const name =
		uid === null
			? undefined
			: ctx.db.select({ name: user.name }).from(user).where(eq(user.id, uid)).get()?.name;
	notify(ctx, 'issue_commented', r, { actorName: name, excerpt: excerpt(body) });
}

function commentOut(ctx: Ctx, ids: number[]): IssueComment[] {
	if (!ids.length) return [];
	const rows = ctx.db
		.select()
		.from(issueComment)
		.where(inArray(issueComment.id, ids))
		.orderBy(asc(issueComment.createdAt), asc(issueComment.id))
		.all();
	const people = personRefs(
		ctx.db,
		rows.flatMap((c) => (c.userId === null ? [] : [c.userId]))
	);
	return rows.map((c) => ({
		id: c.id,
		issueId: c.issueId,
		user: c.userId === null ? null : (people.get(c.userId) ?? null),
		body: c.body,
		createdAt: c.createdAt
	}));
}

export function listComments(ctx: Ctx, id: number): IssueComment[] {
	load(ctx, id);
	const ids = ctx.db
		.select({ id: issueComment.id })
		.from(issueComment)
		.where(eq(issueComment.issueId, id))
		.all()
		.map((r) => r.id);
	return commentOut(ctx, ids);
}

export function addComment(ctx: Ctx, id: number, body: string): IssueComment {
	const r = load(ctx, id);
	const c = addNote(ctx, r, body);
	notifyComment(ctx, r, body);
	return commentOut(ctx, [c.id])[0]!;
}

// ---- links ----

function checkLinkTarget(ctx: Ctx, kind: IssueLinkKind, targetId: number) {
	switch (kind) {
		case 'part':
			if (!ctx.db.select({ id: part.id }).from(part).where(eq(part.id, targetId)).get())
				throw invalid('targetId', `Part ${targetId} not found`);
			return;
		case 'risk': // added by risks
			if (!ctx.db.select({ id: risk.id }).from(risk).where(eq(risk.id, targetId)).get())
				throw invalid('targetId', `Risk ${targetId} not found`);
	}
}

function insertLink(ctx: Ctx, issueId: number, kind: IssueLinkKind, targetId: number) {
	switch (kind) {
		case 'part':
			return insert(ctx, issueLink, { issueId, partId: targetId });
		case 'risk': // added by risks: linked as mitigation. Other roles go through risks.linkIssue.
			return insert(ctx, issueLink, { issueId, riskId: targetId, riskRole: 'mitigation' });
	}
}

export function addLink(ctx: Ctx, id: number, kind: IssueLinkKind, targetId: number): IssueLink {
	load(ctx, id);
	checkLinkTarget(ctx, kind, targetId);
	const dup = ctx.db
		.select({ id: issueLink.id })
		.from(issueLink)
		.where(
			and(
				eq(issueLink.issueId, id),
				kind === 'risk' ? eq(issueLink.riskId, targetId) : eq(issueLink.partId, targetId) // risk added by risks
			)
		)
		.get();
	if (dup) throw conflict('duplicate', 'Already linked');
	const row = insertLink(ctx, id, kind, targetId);
	return linksFor(ctx, [id]).get(id)!.find((l) => l.id === row.id)!;
}

export function removeLink(ctx: Ctx, id: number, linkId: number): { ok: true } {
	const row = ctx.db
		.select()
		.from(issueLink)
		.where(and(eq(issueLink.id, linkId), eq(issueLink.issueId, id)))
		.get();
	if (!row) throw notFound('Link');
	remove(ctx, issueLink, linkId);
	return { ok: true };
}
