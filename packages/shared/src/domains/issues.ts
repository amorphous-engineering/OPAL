/** Contracts for the issues area: tickets, dispositions, containment, comments, links. */
import { z } from 'zod';
import { op, zEmpty, zId, zOk, zPage, zPageInput } from '../op.ts';
import { zTimestamp } from '../time.ts';

export const ISSUE_TYPES = ['non_conformance', 'bug', 'task', 'improvement'] as const;
/** `void` is the terminal state of an issue raised by mistake (it replaces legacy delete). */
export const ISSUE_STATUSES = ['open', 'closed', 'void'] as const;
export const ISSUE_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export const DISPOSITION_TYPES = [
	'use_as_is',
	'rework',
	'repair',
	'scrap',
	'return_to_supplier',
	'no_defect'
] as const;
/** What an undispositioned issue holds. */
export const CONTAINMENTS = ['advisory', 'step', 'op', 'wo'] as const;
/** Widening moves up this ladder freely. Narrowing releases a hold and needs a note. */
export const CONTAINMENT_RANK: Record<(typeof CONTAINMENTS)[number], number> = {
	advisory: 0,
	step: 1,
	op: 2,
	wo: 3
};
/** Derived ticket progress. */
export const TICKET_STATES = ['pending', 'in_work', 'in_review', 'done'] as const;
/** Derived disposition state: advisory issues show plain open | closed. */
export const DISP_STATES = ['open', 'undispositioned', 'dispositioned', 'closed', 'void'] as const;
/**
 * Kinds of record an issue can link to. Each kind is one nullable FK column on
 * `issue_link`. The area that owns the target adds its column and its kind here.
 */
export const ISSUE_LINK_KINDS = ['part', 'risk'] as const; // risk added by risks
export const ISSUE_SORTS = ['number', 'title', 'type', 'state', 'priority', 'created', 'updated'] as const;

export type IssueType = (typeof ISSUE_TYPES)[number];
export type IssueStatus = (typeof ISSUE_STATUSES)[number];
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];
export type DispositionType = (typeof DISPOSITION_TYPES)[number];
export type Containment = (typeof CONTAINMENTS)[number];
export type TicketState = (typeof TICKET_STATES)[number];
export type DispState = (typeof DISP_STATES)[number];
export type IssueLinkKind = (typeof ISSUE_LINK_KINDS)[number];

// A person on an issue, with the same avatar as everywhere else.
export const zUserRef = z.object({ id: z.number().int(), name: z.string(), avatarUrl: z.string().nullable() });
export type UserRef = z.infer<typeof zUserRef>;

export const zIssueLink = z.object({
	id: z.number().int(),
	kind: z.enum(ISSUE_LINK_KINDS),
	targetId: z.number().int(),
	/** Number or name of the target, ready to show. */
	label: z.string(),
	sublabel: z.string().nullable(),
	href: z.string()
});
export type IssueLink = z.infer<typeof zIssueLink>;

/** The execution (work order) an issue holds. The execution area supplies the label. */
export const zExecutionRef = z.object({
	id: z.number().int(),
	label: z.string().nullable(),
	procedureId: z.number().int().nullable(),
	procedureName: z.string().nullable()
});
export type ExecutionRef = z.infer<typeof zExecutionRef>;

export const zLinkedRisk = z.object({
	riskId: z.number().int(),
	riskNumber: z.string(),
	title: z.string(),
	relation: z.enum(['mitigation', 'research', 'realized'])
});
export type LinkedRisk = z.infer<typeof zLinkedRisk>;

/** A redline operation spawned on the work order for this issue. */
export const zRedlineOp = z.object({
	stepNumber: z.number().int(),
	label: z.string(),
	title: z.string(),
	status: z.string()
});
export type RedlineOp = z.infer<typeof zRedlineOp>;

export const zStepOption = z.object({ id: z.number().int(), label: z.string(), title: z.string() });
export type StepOption = z.infer<typeof zStepOption>;

export const zIssue = z.object({
	id: z.number().int(),
	issueNumber: z.string(),
	projectId: z.number().int(), // added by projects
	projectCode: z.string(), // added by projects
	projectName: z.string(), // added by projects
	title: z.string(),
	description: z.string().nullable(),
	issueType: z.enum(ISSUE_TYPES),
	status: z.enum(ISSUE_STATUSES),
	priority: z.enum(ISSUE_PRIORITIES),
	containment: z.enum(CONTAINMENTS),
	containmentStepId: z.number().int().nullable(),
	executionId: z.number().int().nullable(),
	execution: zExecutionRef.nullable(),
	raisedStepId: z.number().int().nullable(),
	raisedStepLabel: z.string().nullable(),
	containmentStepLabel: z.string().nullable(),
	dispState: z.enum(DISP_STATES),
	dispositioned: z.boolean(),
	ticketState: z.enum(TICKET_STATES),
	isBlocking: z.boolean(),
	selfDispositioned: z.boolean(),
	shouldBe: z.string().nullable(),
	actual: z.string().nullable(),
	stepsToReproduce: z.string().nullable(),
	expectedBehavior: z.string().nullable(),
	actualBehavior: z.string().nullable(),
	expectedBenefit: z.string().nullable(),
	rootCause: z.string().nullable(),
	correctiveAction: z.string().nullable(),
	dispositionType: z.enum(DISPOSITION_TYPES).nullable(),
	dispositionRationale: z.string().nullable(),
	dispositionedAt: zTimestamp.nullable(),
	dispositionedBy: zUserRef.nullable(),
	workStartedAt: zTimestamp.nullable(),
	workStartedBy: zUserRef.nullable(),
	reviewRequestedAt: zTimestamp.nullable(),
	reviewRequestedBy: zUserRef.nullable(),
	closedAt: zTimestamp.nullable(),
	closedBy: zUserRef.nullable(),
	raisedBy: zUserRef.nullable(),
	assignedTo: zUserRef.nullable(),
	links: z.array(zIssueLink),
	createdAt: zTimestamp,
	updatedAt: zTimestamp
});
export type Issue = z.infer<typeof zIssue>;

/** The issue plus what the viewer may do with it. */
export const zIssueDetail = zIssue.extend({
	canDisposition: z.boolean(),
	canApprove: z.boolean(),
	raisedOpOrder: z.number().int().nullable(),
	risks: z.array(zLinkedRisk),
	redlineOps: z.array(zRedlineOp),
	gateReasons: z.object({ disposition: z.string().optional(), approve: z.string().optional() })
});
export type IssueDetail = z.infer<typeof zIssueDetail>;

export const zIssueComment = z.object({
	id: z.number().int(),
	issueId: z.number().int(),
	user: zUserRef.nullable(),
	body: z.string(),
	createdAt: zTimestamp
});
export type IssueComment = z.infer<typeof zIssueComment>;

/** What an issue stops: the scope, where it is, and a line to show ("WO-9 COMPLETE"). */
export const zHoldTarget = z.object({
	scope: z.enum(['step', 'op', 'wo']),
	executionId: z.number().int(),
	stepId: z.number().int().nullable(),
	label: z.string(),
	href: z.string()
});
export type HoldTarget = z.infer<typeof zHoldTarget>;

const text = z.string().nullable().optional();
const zLinkInput = z.object({ kind: z.enum(ISSUE_LINK_KINDS), targetId: zId });

export const zIssueCreate = z.object({
	projectId: zId, // added by projects
	title: z.string().trim().min(1).max(255),
	description: text,
	issueType: z.enum(ISSUE_TYPES).default('task'),
	priority: z.enum(ISSUE_PRIORITIES).default('medium'),
	containment: z.enum(CONTAINMENTS).default('advisory'),
	containmentStepId: z.number().int().positive().nullable().optional(),
	shouldBe: text,
	actual: text,
	stepsToReproduce: text,
	expectedBehavior: text,
	actualBehavior: text,
	expectedBenefit: text,
	executionId: z.number().int().positive().nullable().optional(),
	raisedStepId: z.number().int().positive().nullable().optional(),
	assignedToId: z.number().int().positive().nullable().optional(),
	links: z.array(zLinkInput).default([])
});

export const zIssueUpdate = z.object({
	id: zId,
	projectId: zId.optional(), // added by projects
	title: z.string().trim().min(1).max(255).optional(),
	description: text,
	issueType: z.enum(ISSUE_TYPES).optional(),
	/** `closed` needs the issue.approve gate. `open` reopens a closed issue. */
	status: z.enum(['open', 'closed']).optional(),
	priority: z.enum(ISSUE_PRIORITIES).optional(),
	shouldBe: text,
	actual: text,
	stepsToReproduce: text,
	expectedBehavior: text,
	actualBehavior: text,
	expectedBenefit: text,
	rootCause: text,
	correctiveAction: text,
	/** Draft only. The signature is `issues.signDisposition`. null clears the draft. */
	dispositionType: z.enum(DISPOSITION_TYPES).nullable().optional(),
	dispositionRationale: text,
	/** Absent leaves it alone. null clears it. */
	assignedToId: z.number().int().positive().nullable().optional(),
	executionId: z.number().int().positive().nullable().optional()
});

export const issues = {
	list: op({
		name: 'issues.list',
		method: 'GET',
		path: '/issues',
		summary:
			'List issues. Default order: undispositioned containment issues first, then newest. `state` is a comma list of ticket states.',
		input: zPageInput.extend({
			q: z.string().optional(),
			projectId: zId.optional(), // added by projects
			issueType: z.enum(ISSUE_TYPES).optional(),
			status: z.enum(ISSUE_STATUSES).optional(),
			dispState: z.enum(DISP_STATES).optional(),
			state: z.string().optional(),
			priority: z.enum(ISSUE_PRIORITIES).optional(),
			assignedToId: zId.optional(),
			partId: zId.optional(),
			executionId: zId.optional(),
			procedureId: zId.optional(), // added by execution: issues raised on executions of this procedure
			sort: z.enum(ISSUE_SORTS).optional(),
			dir: z.enum(['asc', 'desc']).default('desc')
		}),
		output: zPage(zIssue).extend({ total: z.number().int() }),
		access: 'signed-in',
		mcp: true
	}),
	assignees: op({
		name: 'issues.assignees',
		method: 'GET',
		path: '/issues/assignees',
		summary: 'Active users an issue can be assigned to.',
		input: zEmpty,
		output: z.array(zUserRef),
		access: 'signed-in',
		mcp: false
	}),
	get: op({
		name: 'issues.get',
		method: 'GET',
		path: '/issues/:id',
		summary: 'Get one issue with its links and the viewer gate flags.',
		input: z.object({ id: zId }),
		output: zIssueDetail,
		access: 'signed-in',
		mcp: true
	}),
	create: op({
		name: 'issues.create',
		method: 'POST',
		path: '/issues',
		summary:
			'Raise an issue. Any containment above advisory holds work until a disposition is signed.',
		input: zIssueCreate,
		output: zIssue,
		access: 'signed-in',
		mcp: true
	}),
	update: op({
		name: 'issues.update',
		method: 'PATCH',
		path: '/issues/:id',
		summary:
			'Edit an issue. Closing needs the issue.approve gate. A signed disposition cannot be edited.',
		input: zIssueUpdate,
		output: zIssue,
		access: 'signed-in',
		mcp: true
	}),
	start: op({
		name: 'issues.start',
		method: 'POST',
		path: '/issues/:id/start',
		summary: 'Advisory issue: pending to in work. Containment issues enter work by disposition.',
		input: z.object({ id: zId }),
		output: zIssue,
		access: 'signed-in',
		mcp: true
	}),
	review: op({
		name: 'issues.review',
		method: 'POST',
		path: '/issues/:id/review',
		summary: 'In work to in review.',
		input: z.object({ id: zId }),
		output: zIssue,
		access: 'signed-in',
		mcp: true
	}),
	returnFromReview: op({
		name: 'issues.returnFromReview',
		method: 'POST',
		path: '/issues/:id/review/return',
		summary: 'In review to in work. The comment is stored on the issue.',
		input: z.object({ id: zId, comment: z.string().min(1) }),
		output: zIssue,
		access: 'signed-in',
		mcp: true
	}),
	signOff: op({
		name: 'issues.signOff',
		method: 'POST',
		path: '/issues/:id/signoff',
		summary: 'In review to done: closes the issue under the closing rules.',
		input: z.object({ id: zId }),
		output: zIssue,
		access: 'issue.approve',
		mcp: false,
		humanOnly: true
	}),
	signDisposition: op({
		name: 'issues.signDisposition',
		method: 'POST',
		path: '/issues/:id/disposition',
		summary: 'Sign the disposition. Releases every containment the issue holds.',
		input: z.object({
			id: zId,
			dispositionType: z.enum(DISPOSITION_TYPES),
			dispositionRationale: z.string().trim().min(1)
		}),
		output: zIssue,
		access: 'issue.disposition',
		mcp: true,
		humanOnly: true
	}),
	setContainment: op({
		name: 'issues.setContainment',
		method: 'POST',
		path: '/issues/:id/containment',
		summary:
			'Change the containment scope. Narrowing a hold needs a note. containmentStepId: absent keeps, null clears.',
		input: z.object({
			id: zId,
			containment: z.enum(CONTAINMENTS),
			containmentStepId: z.number().int().positive().nullable().optional(),
			note: z.string().nullable().optional()
		}),
		output: zIssue,
		access: 'signed-in',
		mcp: true
	}),
	void: op({
		name: 'issues.void',
		method: 'POST',
		path: '/issues/:id/void',
		summary: 'Void an issue raised by mistake. Releases its holds. The reason is kept as a comment.',
		input: z.object({ id: zId, reason: z.string().trim().min(1) }),
		output: zIssue,
		access: 'signed-in',
		mcp: true
	}),
	steps: op({
		name: 'issues.steps',
		method: 'GET',
		path: '/issues/:id/steps',
		summary: 'Steps of the issue work order: the candidates for a containment boundary.',
		input: z.object({ id: zId }),
		output: z.array(zStepOption),
		access: 'signed-in',
		mcp: false
	}),
	holding: op({
		name: 'issues.holding',
		method: 'GET',
		path: '/issues/:id/holding',
		summary:
			'What the issue is stopping. Empty for advisory or dispositioned issues. `containment` previews a proposed scope.',
		input: z.object({ id: zId, containment: z.enum(CONTAINMENTS).optional() }),
		output: z.array(zHoldTarget),
		access: 'signed-in',
		mcp: true
	}),
	listComments: op({
		name: 'issues.listComments',
		method: 'GET',
		path: '/issues/:id/comments',
		summary: 'Comments and activity notes on an issue, oldest first.',
		input: z.object({ id: zId }),
		output: z.array(zIssueComment),
		access: 'signed-in',
		mcp: true
	}),
	addComment: op({
		name: 'issues.addComment',
		method: 'POST',
		path: '/issues/:id/comments',
		summary: 'Comment on an issue.',
		input: z.object({ id: zId, body: z.string().trim().min(1) }),
		output: zIssueComment,
		access: 'signed-in',
		mcp: true
	}),
	addLink: op({
		name: 'issues.addLink',
		method: 'POST',
		path: '/issues/:id/links',
		summary: 'Link an issue to another record.',
		input: z.object({ id: zId, kind: z.enum(ISSUE_LINK_KINDS), targetId: zId }),
		output: zIssueLink,
		access: 'signed-in',
		mcp: true
	}),
	removeLink: op({
		name: 'issues.removeLink',
		method: 'DELETE',
		path: '/issues/:id/links/:linkId',
		summary: 'Remove a link from an issue.',
		input: z.object({ id: zId, linkId: zId }),
		output: zOk,
		access: 'signed-in',
		mcp: true
	})
};
