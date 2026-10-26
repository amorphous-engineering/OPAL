/**
 * Contracts for the execution area: executions (work orders), step execution state, sign-offs,
 * notes, holds, redlines, kitting and consumption, production, the document view model, the
 * report.
 *
 * Rules:
 *   - a step's content has one home, the published snapshot (or the redline row for an ad-hoc
 *     step). An execution holds only state;
 *   - the key of a step in every execution path is the id of its step execution row
 *     (`stepId` in the paths below). The document also carries the snapshot step id
 *     (`templateStepId`) for links back to the procedure;
 *   - holds are derived from issues, never stored.
 */
import { z } from 'zod';
import { op, zId, zOk, zPage, zPageInput } from '../op.ts';
import { zQty } from '../qty.ts';
import { zTimestamp } from '../time.ts';
import { zPersonRef } from './org.ts';
import { zProcedureDataSchema } from './procedures.ts';

export const EXECUTION_STATUSES = ['cut', 'in_work', 'completed', 'aborted'] as const;
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number];
export const EXECUTION_ACTIVE_STATUSES = ['cut', 'in_work'] as const;
export const EXECUTION_PRIORITIES = ['normal', 'high', 'urgent'] as const;
export type ExecutionPriority = (typeof EXECUTION_PRIORITIES)[number];
/**
 * Step states. `awaiting_signoff`: the first slot is signed and later slots wait. A step on
 * hold is still `pending` (a hold is derived from an issue and shows as a blocker).
 */
export const EXEC_STEP_STATUSES = ['pending', 'awaiting_signoff', 'completed', 'skipped'] as const;
export type ExecStepStatus = (typeof EXEC_STEP_STATUSES)[number];
export const EXEC_TERMINAL_STATUSES: readonly string[] = ['completed', 'skipped'];
export const EXECUTION_SORT_KEYS = ['workOrder', 'procedure', 'status', 'created', 'target', 'priority'] as const;
export const EXEC_BLOCKER_KINDS = [
	'nc',
	'sequence',
	'dependency',
	'redline',
	'children',
	'hold',
	'signoff',
	'role',
	'out_of_spec'
] as const;
export const PRODUCTION_STATUSES = ['planned', 'wip', 'completed'] as const;
export const EXEC_USAGES = ['consume', 'tooling'] as const;

// ---------------------------------------------------------------- shared shapes

export const zExecBlocker = z.object({
	kind: z.enum(EXEC_BLOCKER_KINDS),
	message: z.string(),
	issueId: z.number().int().nullable(),
	issueNumber: z.string().nullable()
});
export type ExecBlocker = z.infer<typeof zExecBlocker>;

export const zExecHold = z.object({
	issueId: z.number().int(),
	issueNumber: z.string(),
	title: z.string(),
	kind: z.enum(['raised', 'bound']),
	dispositionState: z.string(),
	ticketState: z.string()
});
export type ExecHold = z.infer<typeof zExecHold>;

export const zExecCursor = z.object({
	userId: z.number().int(),
	name: z.string().nullable(),
	avatarUrl: z.string().nullable(),
	initials: z.string(),
	focusedAt: zTimestamp.nullable(),
	stale: z.boolean()
});
export type ExecCursor = z.infer<typeof zExecCursor>;

export const zExecRosterEntry = zExecCursor.extend({
	stepId: z.number().int().nullable(),
	stepNumber: z.string().nullable()
});
export type ExecRosterEntry = z.infer<typeof zExecRosterEntry>;

/**
 * Time one person worked on one OP. `seconds` counts finished clock-ins. `since`: the start of
 * the clock-in that is still open (the client adds the time from then to now), else null.
 */
export const zLaborRow = z.object({
	opId: z.number().int(),
	userId: z.number().int(),
	name: z.string().nullable(),
	avatarUrl: z.string().nullable(),
	seconds: z.number().int(),
	since: zTimestamp.nullable()
});
export type LaborRow = z.infer<typeof zLaborRow>;

/** One execution in a list. */
export const zExecutionRow = z.object({
	id: z.number().int(),
	woNumber: z.string(),
	projectId: z.number().int(),
	projectCode: z.string(),
	procedureId: z.number().int(),
	procedureNumber: z.string(),
	procedureName: z.string(),
	versionId: z.number().int(),
	versionNumber: z.number().int(),
	status: z.enum(EXECUTION_STATUSES),
	priority: z.enum(EXECUTION_PRIORITIES),
	createdAt: zTimestamp,
	startedAt: zTimestamp.nullable(),
	completedAt: zTimestamp.nullable(),
	scheduledStartAt: zTimestamp.nullable(),
	targetCompletionAt: zTimestamp.nullable(),
	createdBy: z.string().nullable(),
	progressDone: z.number().int(),
	progressTotal: z.number().int(),
	heldBy: z.array(z.string()),
	working: z.array(
		z.object({
			userId: z.number().int(),
			name: z.string().nullable(),
			avatarUrl: z.string().nullable(),
			stepNumber: z.string().nullable()
		})
	)
});
export type ExecutionRow = z.infer<typeof zExecutionRow>;

export const zExecutionList = zPage(zExecutionRow).extend({
	total: z.number().int(),
	/** Per status, for the active filters except status. */
	counts: z.record(z.string(), z.number().int())
});

/** The state of one step, as the execution record shows it. */
export const zExecStepState = z.object({
	id: z.number().int(),
	number: z.string(),
	title: z.string(),
	level: z.number().int(),
	parentId: z.number().int().nullable(),
	status: z.enum(EXEC_STEP_STATUSES),
	dataCaptured: z.record(z.string(), z.unknown()).nullable(),
	skipReason: z.string().nullable(),
	startedAt: zTimestamp.nullable(),
	completedAt: zTimestamp.nullable(),
	completedBy: z.string().nullable(),
	isAdHoc: z.boolean()
});

export const zExecution = zExecutionRow.extend({
	procedureType: z.enum(['op', 'build']),
	versionCreatedAt: zTimestamp,
	durationSeconds: z.number().int().nullable(),
	active: z.boolean(),
	steps: z.array(zExecStepState)
});
export type Execution = z.infer<typeof zExecution>;

// ---------------------------------------------------------------- cut preview

export const zPreviewPart = z.object({
	partId: z.number().int(),
	partNumber: z.string(),
	partName: z.string(),
	uom: z.string(),
	perWorkOrder: zQty,
	required: zQty,
	available: zQty,
	isAvailable: z.boolean(),
	usage: z.enum(EXEC_USAGES).nullable()
});
export const zCutPreview = z.object({
	procedureId: z.number().int(),
	procedureNumber: z.string(),
	procedureName: z.string(),
	procedureType: z.enum(['op', 'build']),
	projectId: z.number().int(),
	versions: z.array(
		z.object({ id: z.number().int(), number: z.number().int(), createdAt: zTimestamp, isCurrent: z.boolean() })
	),
	versionId: z.number().int(),
	versionNumber: z.number().int(),
	stepCount: z.number().int(),
	opCount: z.number().int(),
	quantity: z.number().int(),
	outputs: z.array(
		z.object({
			partId: z.number().int(),
			partNumber: z.string(),
			partName: z.string(),
			quantityEach: zQty,
			serials: z.array(z.string())
		})
	),
	kit: z.array(zPreviewPart),
	stepKit: z.array(zPreviewPart),
	allAvailable: z.boolean()
});
export type CutPreview = z.infer<typeof zCutPreview>;

// ---------------------------------------------------------------- the document

export const zDocSignoff = z.object({
	slot: z.number().int(),
	label: z.string(),
	role: z.string().nullable(),
	signedBy: zPersonRef.nullable(),
	signedAt: zTimestamp.nullable(),
	canSign: z.boolean(),
	blockers: z.array(zExecBlocker)
});

export const zDocNoteFile = z.object({
	id: z.number().int(),
	filename: z.string(),
	mimeType: z.string(),
	sizeBytes: z.number().int(),
	url: z.string(),
	isImage: z.boolean()
});

export const zDocNote = z.object({
	id: z.number().int(),
	author: zPersonRef.nullable(),
	createdAt: zTimestamp,
	body: z.string(),
	attachments: z.array(zDocNoteFile)
});

export const zDocAttachment = z.object({
	id: z.number().int(),
	filename: z.string(),
	mimeType: z.string(),
	sizeBytes: z.number().int(),
	kind: z.string().nullable(),
	note: z.string().nullable(),
	uploadedBy: z.string().nullable(),
	createdAt: zTimestamp
});

export const zDocConsumption = z.object({
	id: z.number().int(),
	stockId: z.number().int(),
	partId: z.number().int(),
	partNumber: z.string(),
	partName: z.string(),
	opalNumber: z.string(),
	quantity: zQty,
	lotNumber: z.string().nullable(),
	location: z.string(),
	usage: z.enum(EXEC_USAGES),
	stepId: z.number().int().nullable(),
	stepNumber: z.string().nullable()
});
export type DocConsumption = z.infer<typeof zDocConsumption>;

export const zDocStepKit = z.object({
	partId: z.number().int(),
	partNumber: z.string(),
	partName: z.string(),
	quantity: zQty,
	usage: z.enum(EXEC_USAGES),
	notes: z.string().nullable()
});

export const zDocImage = z.object({ sha256: z.string(), filename: z.string(), caption: z.string().nullable() });

export const zDocStep = z.object({
	/** Step execution id: the key of the step in every execution path. */
	id: z.number().int(),
	/** The snapshot step, null for a redline step. */
	templateStepId: z.number().int().nullable(),
	number: z.string(),
	title: z.string(),
	level: z.number().int(),
	isOp: z.boolean(),
	parentId: z.number().int().nullable(),
	status: z.enum(EXEC_STEP_STATUSES),
	instructions: z.string().nullable(),
	callouts: z.array(z.object({ kind: z.enum(['caution', 'info']), text: z.string() })),
	role: z.string().nullable(),
	requiresSignoff: z.boolean(),
	isContingency: z.boolean(),
	estimatedDurationMinutes: z.number().int().nullable(),
	images: z.array(zDocImage),
	stepKit: z.array(zDocStepKit),
	dataSchema: zProcedureDataSchema.nullable(),
	dataCaptured: z.record(z.string(), z.unknown()).nullable(),
	skipReason: z.string().nullable(),
	startedAt: zTimestamp.nullable(),
	completed: z.object({ by: z.string().nullable(), initials: z.string(), at: zTimestamp.nullable() }).nullable(),
	signedOff: z.object({ by: z.string().nullable(), at: zTimestamp.nullable() }).nullable(),
	durationSeconds: z.number().int().nullable(),
	cursors: z.array(zExecCursor),
	holds: z.array(zExecHold),
	issueHistory: z.array(
		z.object({
			issueId: z.number().int(),
			issueNumber: z.string(),
			state: z.string(),
			ticketState: z.string(),
			dispositionType: z.string().nullable()
		})
	),
	/** Everything that refuses the step's complete. A non-empty list makes the control inert. */
	completeBlockers: z.array(zExecBlocker),
	skipBlockers: z.array(zExecBlocker),
	notes: z.array(zDocNote),
	signoffs: z.array(zDocSignoff),
	attachments: z.array(zDocAttachment),
	consumptions: z.array(zDocConsumption),
	/** "WAITING ON OP 2" / "WAITING ON 1.1 +1" */
	waiting: z.string().nullable()
});
export type DocStepOut = z.infer<typeof zDocStep>;

export const zDocOp = z.object({
	id: z.number().int(),
	number: z.string(),
	title: z.string(),
	status: z.enum(EXEC_STEP_STATUSES),
	instructions: z.string().nullable(),
	callouts: z.array(z.object({ kind: z.enum(['caution', 'info']), text: z.string() })),
	role: z.string().nullable(),
	signoffs: z.array(zDocSignoff),
	strictSequence: z.boolean(),
	isContingency: z.boolean(),
	isAdHoc: z.boolean(),
	redline: z
		.object({
			issueId: z.number().int(),
			issueNumber: z.string().nullable(),
			title: z.string().nullable(),
			hostId: z.number().int().nullable()
		})
		.nullable(),
	waitingOnOps: z.array(z.string()),
	holds: z.array(zExecHold),
	openNcs: z.array(z.object({ id: z.number().int(), issueNumber: z.string(), title: z.string() })),
	progress: z.object({ done: z.number().int(), total: z.number().int() }),
	/** The OP's own row; the only row when `steps` is empty. */
	step: zDocStep,
	steps: z.array(zDocStep)
});
export type DocOpOut = z.infer<typeof zDocOp>;

export const zDocIssue = z.object({
	id: z.number().int(),
	issueNumber: z.string(),
	title: z.string(),
	issueType: z.string(),
	priority: z.string(),
	status: z.string(),
	state: z.string(),
	ticketState: z.string(),
	containment: z.string(),
	dispositionType: z.string().nullable(),
	isBlocking: z.boolean(),
	raisedStepNumber: z.string().nullable(),
	createdAt: zTimestamp
});

export const zDocHoldSummary = z.object({
	issueId: z.number().int(),
	issueNumber: z.string(),
	title: z.string(),
	dispositionState: z.string(),
	ticketState: z.string(),
	blocks: z.array(z.string())
});

export const zKitRow = z.object({
	partId: z.number().int(),
	partNumber: z.string(),
	partName: z.string(),
	uom: z.string(),
	qtyRequired: zQty,
	qtyConsumed: zQty,
	variance: zQty
});
export const zUnplannedRow = z.object({
	partId: z.number().int(),
	partNumber: z.string(),
	partName: z.string(),
	qtyConsumed: zQty
});
export const zOutputRow = z.object({
	partId: z.number().int(),
	partNumber: z.string(),
	partName: z.string(),
	quantity: zQty
});
export const zProductionRow = z.object({
	id: z.number().int(),
	stockId: z.number().int(),
	partId: z.number().int(),
	partNumber: z.string(),
	partName: z.string(),
	serialNumber: z.string().nullable(),
	opalNumber: z.string(),
	quantity: zQty,
	lotNumber: z.string().nullable(),
	location: z.string(),
	status: z.enum(PRODUCTION_STATUSES)
});
export type ProductionRow = z.infer<typeof zProductionRow>;

export const zDataRow = z.object({
	stepNumber: z.string(),
	stepId: z.number().int(),
	field: z.string(),
	/** The unit symbol ("in·lbf"), not the stored code. */
	unit: z.string().nullable(),
	value: z.string(),
	/** The field's spec as text ("12.125 – 12.25 in"), or null. */
	spec: z.string().nullable().optional(),
	/** The value is outside the spec. */
	outOfSpec: z.boolean().optional(),
	by: z.string().nullable(),
	at: zTimestamp.nullable()
});

export const zExecutionDocument = z.object({
	execution: z.object({
		id: z.number().int(),
		woNumber: z.string(),
		status: z.enum(EXECUTION_STATUSES),
		active: z.boolean(),
		priority: z.enum(EXECUTION_PRIORITIES),
		projectId: z.number().int(),
		projectCode: z.string(),
		projectName: z.string(),
		procedure: z.object({
			id: z.number().int(),
			templateNumber: z.string(),
			name: z.string(),
			type: z.enum(['op', 'build'])
		}),
		version: z.object({
			id: z.number().int(),
			number: z.number().int(),
			createdAt: zTimestamp,
			createdBy: z.string().nullable()
		}),
		createdAt: zTimestamp,
		createdBy: z.string().nullable(),
		startedAt: zTimestamp.nullable(),
		completedAt: zTimestamp.nullable(),
		scheduledStartAt: zTimestamp.nullable(),
		targetCompletionAt: zTimestamp.nullable(),
		lastActivityAt: zTimestamp.nullable(),
		durationSeconds: z.number().int().nullable()
	}),
	progress: z.object({ done: z.number().int(), total: z.number().int() }),
	ops: z.array(zDocOp),
	contingencyOps: z.array(zDocOp),
	issues: z.array(zDocIssue),
	holds: z.array(zDocHoldSummary),
	roster: z.array(zExecRosterEntry),
	myCursorId: z.number().int().nullable(),
	kit: z.object({ items: z.array(zKitRow), unplanned: z.array(zUnplannedRow) }),
	consumptions: z.array(zDocConsumption),
	outputs: z.array(zOutputRow),
	productions: z.array(zProductionRow),
	kitRelevant: z.boolean(),
	materialRelevant: z.boolean(),
	canFinalize: z.boolean(),
	referenceAttachments: z.array(zDocAttachment),
	attachments: z.array(zDocAttachment),
	dataRows: z.array(zDataRow),
	labor: z.array(zLaborRow),
	generatedAt: zTimestamp
});
export type ExecutionDocument = z.infer<typeof zExecutionDocument>;

/** The light poll: enough to tell whether the document changed, plus presence. */
export const zExecutionState = z.object({
	execution: z.object({
		id: z.number().int(),
		status: z.enum(EXECUTION_STATUSES),
		progress: z.object({ done: z.number().int(), total: z.number().int() })
	}),
	steps: z.array(
		z.object({
			id: z.number().int(),
			number: z.string(),
			title: z.string(),
			status: z.enum(EXEC_STEP_STATUSES),
			cursors: z.array(zExecCursor),
			holds: z.array(zExecHold),
			attachments: z.number().int(),
			consumed: z.number().int(),
			notes: z.number().int()
		})
	),
	roster: z.array(zExecRosterEntry),
	holds: z.array(zDocHoldSummary),
	labor: z.array(zLaborRow),
	generatedAt: zTimestamp
});
export type ExecutionState = z.infer<typeof zExecutionState>;

export const zExecutionHolds = z.object({
	executionId: z.number().int(),
	held: z.boolean(),
	holds: z.array(
		z.object({
			issueId: z.number().int(),
			issueNumber: z.string(),
			title: z.string(),
			priority: z.string(),
			containment: z.string(),
			ticketState: z.string(),
			raisedStepId: z.number().int().nullable(),
			containmentStepId: z.number().int().nullable(),
			blocks: z.array(z.string())
		})
	)
});

// ---------------------------------------------------------------- step writes

export const zSignResult = z.object({
	step: zExecStepState,
	slot: z.number().int(),
	stepCompleted: z.boolean(),
	executionStarted: z.boolean(),
	executionCompleted: z.boolean(),
	signoffs: z.array(
		z.object({
			slot: z.number().int(),
			label: z.string(),
			role: z.string().nullable(),
			signedBy: zPersonRef.nullable(),
			signedAt: zTimestamp.nullable()
		})
	)
});
export type SignResult = z.infer<typeof zSignResult>;

export const zStepNote = z.object({
	id: z.number().int(),
	stepId: z.number().int(),
	author: zPersonRef.nullable(),
	createdAt: zTimestamp,
	body: z.string()
});

export const zExecutionComment = z.object({
	id: z.number().int(),
	executionId: z.number().int(),
	author: zPersonRef.nullable(),
	createdAt: zTimestamp,
	body: z.string()
});
export type ExecutionComment = z.infer<typeof zExecutionComment>;

export const zConsumeLine = z.object({
	stockId: zId,
	quantity: zQty,
	usage: z.enum(EXEC_USAGES).default('consume')
});

export const zConsumptionRow = z.object({
	id: z.number().int(),
	stockId: z.number().int(),
	partId: z.number().int(),
	partName: z.string(),
	quantity: zQty,
	location: z.string(),
	lotNumber: z.string().nullable()
});

export const zKitAvailability = z.object({
	executionId: z.number().int(),
	allAvailable: z.boolean(),
	items: z.array(
		z.object({
			partId: z.number().int(),
			partNumber: z.string(),
			partName: z.string(),
			uom: z.string(),
			quantityRequired: zQty,
			quantityAvailable: zQty,
			isAvailable: z.boolean(),
			locations: z.array(
				z.object({
					stockId: z.number().int(),
					opalNumber: z.string(),
					location: z.string(),
					lotNumber: z.string().nullable(),
					quantity: zQty
				})
			)
		})
	)
});

export const zBomReconciliation = z.object({
	kitItems: z.array(zKitRow),
	unplanned: z.array(zUnplannedRow),
	outputs: z.array(zProductionRow)
});

export const zRedlineStepInput = z.object({
	title: z.string().trim().min(1).max(255),
	instructions: z.string().nullish(),
	dataSchema: zProcedureDataSchema.nullish(),
	requiresSignoff: z.boolean().default(false)
});

export const zRedline = z.object({
	id: z.number().int(),
	executionId: z.number().int(),
	issueId: z.number().int(),
	issueNumber: z.string().nullable(),
	hostId: z.number().int().nullable(),
	opStepId: z.number().int(),
	number: z.string(),
	title: z.string(),
	status: z.enum(EXEC_STEP_STATUSES),
	createdAt: zTimestamp,
	steps: z.array(zExecStepState)
});
export type Redline = z.infer<typeof zRedline>;

export const zParticipant = z.object({
	userId: z.number().int(),
	name: z.string(),
	joinedAt: zTimestamp,
	lastStepId: z.number().int().nullable()
});
export const zParticipants = z.object({ executionId: z.number().int(), participants: z.array(zParticipant) });

/** The completed-execution report. */
export const zExecutionReport = z.object({
	execution: z.object({
		id: z.number().int(),
		woNumber: z.string(),
		status: z.string(),
		projectCode: z.string(),
		procedureId: z.number().int(),
		procedureName: z.string(),
		versionNumber: z.number().int(),
		operator: z.string().nullable(),
		startedAt: zTimestamp.nullable(),
		completedAt: zTimestamp.nullable()
	}),
	generatedAt: zTimestamp,
	endItems: z.array(
		z.object({
			partId: z.number().int(),
			partName: z.string(),
			partNumber: z.string(),
			opalNumber: z.string().nullable(),
			serialNumber: z.string().nullable(),
			quantity: zQty,
			status: z.string()
		})
	),
	operations: z.array(
		z.object({
			stepNumber: z.string(),
			level: z.number().int(),
			title: z.string(),
			status: z.string(),
			startedAt: zTimestamp.nullable(),
			completedAt: zTimestamp.nullable(),
			operator: z.string().nullable(),
			signoffs: z.array(
				z.object({
					slot: z.number().int(),
					label: z.string(),
					role: z.string().nullable(),
					signedBy: z.string().nullable(),
					signedAt: zTimestamp.nullable()
				})
			)
		})
	),
	dataCollects: z.array(
		z.object({
			stepNumber: z.string(),
			stepTitle: z.string(),
			rows: z.array(
				z.object({
					label: z.string(),
					value: z.string(),
					unit: z.string().nullable(),
					spec: z.string().nullable().optional(),
					outOfSpec: z.boolean().optional()
				})
			)
		})
	),
	chartDatasets: z.array(
		z.object({
			datasetId: z.number().int(),
			name: z.string(),
			chartFields: z.array(z.object({ name: z.string(), label: z.string().optional(), unit: z.string().optional() })),
			fields: z.array(z.object({ name: z.string(), label: z.string().optional(), unit: z.string().optional() })),
			points: z.array(z.object({ recordedAt: zTimestamp, values: z.record(z.string(), z.unknown()) }))
		})
	),
	issues: z.array(
		z.object({
			id: z.number().int(),
			issueNumber: z.string(),
			issueType: z.string(),
			priority: z.string(),
			status: z.string(),
			title: z.string(),
			rootCause: z.string().nullable(),
			dispositionType: z.string().nullable(),
			createdAt: zTimestamp
		})
	),
	closeoutAttachments: z.array(z.object({ id: z.number().int(), filename: z.string(), createdAt: zTimestamp }))
});
export type ExecutionReport = z.infer<typeof zExecutionReport>;

// ---------------------------------------------------------------- inputs

const zStepPath = { id: zId, stepId: zId };
const zLocalTime = z.iso.datetime({ offset: true });

export const execution = {
	list: op({
		name: 'execution.list',
		method: 'GET',
		path: '/executions',
		summary:
			'List executions (work orders) with progress, holds and who is working. Filters: status (comma list), procedureId, projectId, q, mine, held.',
		input: zPageInput.extend({
			status: z.string().optional(),
			procedureId: z.coerce.number().int().positive().optional(),
			projectId: z.coerce.number().int().positive().optional(),
			q: z.string().optional(),
			mine: z.enum(['true', 'false']).optional(),
			held: z.enum(['true', 'false']).optional(),
			sort: z.enum(EXECUTION_SORT_KEYS).optional(),
			dir: z.enum(['asc', 'desc']).default('desc')
		}),
		output: zExecutionList,
		access: 'signed-in',
		mcp: true
	}),
	preview: op({
		name: 'execution.preview',
		method: 'GET',
		path: '/executions/preview',
		summary:
			'Cut preview: versions, the serials build outputs would get, and a kit check scaled by quantity. Allocates nothing.',
		input: z.object({
			procedureId: zId,
			versionId: z.coerce.number().int().positive().optional(),
			quantity: z.coerce.number().int().min(1).max(100).default(1)
		}),
		output: zCutPreview,
		access: 'signed-in',
		mcp: true
	}),
	create: op({
		name: 'execution.create',
		method: 'POST',
		path: '/executions',
		summary:
			'Cut execution(s) from a published procedure version. The project defaults to the procedure project. quantity above 1 cuts a batch; the result is the first, `cutIds` lists all.',
		input: z.object({
			procedureId: zId,
			versionId: zId.optional(),
			projectId: zId.optional(),
			quantity: z.number().int().min(1).max(100).default(1),
			priority: z.enum(EXECUTION_PRIORITIES).default('normal'),
			scheduledStartAt: zLocalTime.nullish(),
			targetCompletionAt: zLocalTime.nullish()
		}),
		output: zExecution.extend({ cutIds: z.array(z.number().int()) }),
		access: 'signed-in',
		mcp: true
	}),
	get: op({
		name: 'execution.get',
		method: 'GET',
		path: '/executions/:id',
		summary: 'One execution with the state of every step.',
		input: z.object({ id: zId }),
		output: zExecution,
		access: 'signed-in',
		mcp: true
	}),
	update: op({
		name: 'execution.update',
		method: 'PATCH',
		path: '/executions/:id',
		summary: 'Change the project, priority or dates of an active execution.',
		input: z.object({
			id: zId,
			projectId: zId.optional(),
			priority: z.enum(EXECUTION_PRIORITIES).optional(),
			scheduledStartAt: zLocalTime.nullish(),
			targetCompletionAt: zLocalTime.nullish()
		}),
		output: zExecution,
		access: 'signed-in',
		mcp: true
	}),
	cancel: op({
		name: 'execution.cancel',
		method: 'POST',
		path: '/executions/:id/cancel',
		summary: 'Abort an active execution. Status is otherwise derived from the work done.',
		input: z.object({ id: zId, reason: z.string().trim().max(2000).nullish() }),
		output: zExecution,
		access: 'signed-in',
		mcp: true
	}),
	document: op({
		name: 'execution.document',
		method: 'GET',
		path: '/executions/:id/document',
		summary:
			'The execution document: OPs and steps with computed gates, holds, cursors, notes, evidence, kit and consumption. A pure read.',
		input: z.object({ id: zId }),
		output: zExecutionDocument,
		access: 'signed-in',
		mcp: false
	}),
	state: op({
		name: 'execution.state',
		method: 'GET',
		path: '/executions/:id/state',
		summary: 'Light state: step statuses, presence and holds. The poll doubles as a presence heartbeat.',
		input: z.object({ id: zId }),
		output: zExecutionState,
		access: 'signed-in',
		mcp: true
	}),
	holds: op({
		name: 'execution.holds',
		method: 'GET',
		path: '/executions/:id/holds',
		summary: 'Every undispositioned issue holding the execution, and what each blocks.',
		input: z.object({ id: zId }),
		output: zExecutionHolds,
		access: 'signed-in',
		mcp: true
	}),
	report: op({
		name: 'execution.report',
		method: 'GET',
		path: '/executions/:id/report',
		summary: 'Report content of a completed execution.',
		input: z.object({ id: zId }),
		output: zExecutionReport,
		access: 'signed-in',
		mcp: true
	}),
	qr: op({
		name: 'execution.qr',
		method: 'GET',
		path: '/executions/:id/qr.svg',
		summary: 'QR code linking to the execution page. origin: the browser origin.',
		input: z.object({ id: zId, origin: z.string().optional() }),
		output: z.string(),
		access: 'signed-in',
		mcp: false,
		produces: 'image/svg+xml'
	}),
	focus: op({
		name: 'execution.focus',
		method: 'POST',
		path: '/executions/:id/focus',
		summary: 'Claim the OP a step belongs to (one claim per user per execution). Presence, not an event.',
		input: z.object({ id: zId, stepId: zId }),
		output: z.object({ stepId: z.number().int(), focusedAt: zTimestamp }),
		access: 'signed-in',
		mcp: true
	}),
	release: op({
		name: 'execution.release',
		method: 'DELETE',
		path: '/executions/:id/focus',
		summary: 'Release the claim.',
		input: z.object({ id: zId }),
		output: zOk,
		access: 'signed-in',
		mcp: true
	}),
	join: op({
		name: 'execution.join',
		method: 'POST',
		path: '/executions/:id/join',
		summary: 'Join an execution as a participant.',
		input: z.object({ id: zId }),
		output: zParticipants,
		access: 'signed-in',
		mcp: true
	}),
	leave: op({
		name: 'execution.leave',
		method: 'POST',
		path: '/executions/:id/leave',
		summary: 'Stop participating. The claim stays.',
		input: z.object({ id: zId }),
		output: zOk,
		access: 'signed-in',
		mcp: true
	}),
	participants: op({
		name: 'execution.participants',
		method: 'GET',
		path: '/executions/:id/participants',
		summary: 'Who joined the execution.',
		input: z.object({ id: zId }),
		output: zParticipants,
		access: 'signed-in',
		mcp: true
	}),
	complete: op({
		name: 'execution.complete',
		method: 'POST',
		path: '/executions/:id/steps/:stepId/complete',
		summary:
			'Sign slot 0 of a step, with the captured data validated against the step data schema. Refused while a hold, sequence, dependency, redline or open sub-step stands.',
		input: z.object({
			...zStepPath,
			dataCaptured: z.record(z.string(), z.unknown()).nullish(),
			notes: z.string().nullish()
		}),
		output: zSignResult,
		access: 'signed-in',
		mcp: true,
		humanOnly: true
	}),
	sign: op({
		name: 'execution.sign',
		method: 'POST',
		path: '/executions/:id/steps/:stepId/signoffs/:slot',
		summary:
			'Sign one slot of a step sign-off list. A step is complete when its last slot is signed. Data capture rides with slot 0.',
		input: z.object({
			...zStepPath,
			slot: z.coerce.number().int().min(0),
			dataCaptured: z.record(z.string(), z.unknown()).nullish()
		}),
		output: zSignResult,
		access: 'signed-in',
		mcp: true,
		humanOnly: true
	}),
	signoff: op({
		name: 'execution.signoff',
		method: 'POST',
		path: '/executions/:id/steps/:stepId/signoff',
		summary: 'Sign the next unsigned slot of a step that awaits sign-off.',
		input: z.object(zStepPath),
		output: zSignResult,
		access: 'signed-in',
		mcp: true,
		humanOnly: true
	}),
	skip: op({
		name: 'execution.skip',
		method: 'POST',
		path: '/executions/:id/steps/:stepId/skip',
		summary: 'Skip a step (not applicable). Held scope and open redlines refuse it.',
		input: z.object({ ...zStepPath, reason: z.string().trim().max(2000).nullish() }),
		output: zSignResult,
		access: 'signed-in',
		mcp: true
	}),
	addNote: op({
		name: 'execution.addNote',
		method: 'POST',
		path: '/executions/:id/steps/:stepId/notes',
		summary:
			'Append a timestamped, authored note to a step. Any step state, any execution state. Attach files with POST /api/attachments (ownerType step_note).',
		input: z.object({ ...zStepPath, body: z.string() }),
		output: zStepNote,
		access: 'signed-in',
		mcp: true
	}),
	listComments: op({
		name: 'execution.listComments',
		method: 'GET',
		path: '/executions/:id/comments',
		summary: 'The comment thread of a work order, oldest first. Step notes are separate (on each step).',
		input: z.object({ id: zId }),
		output: z.array(zExecutionComment),
		access: 'signed-in',
		mcp: true
	}),
	addComment: op({
		name: 'execution.addComment',
		method: 'POST',
		path: '/executions/:id/comments',
		summary: 'Add a comment to the thread of a work order. Any execution state. Markdown.',
		input: z.object({ id: zId, body: z.string().trim().min(1).max(4000) }),
		output: zExecutionComment,
		access: 'signed-in',
		mcp: true
	}),
	raiseNc: op({
		name: 'execution.raiseNc',
		method: 'POST',
		path: '/executions/:id/steps/:stepId/nc',
		summary:
			'Raise a non-conformance from a step. The issue holds what its containment says until dispositioned. The project, execution and step come from the context.',
		input: z.object({
			...zStepPath,
			title: z.string().trim().min(1).max(255),
			description: z.string().nullish(),
			priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
			shouldBe: z.string().nullish(),
			actual: z.string().nullish(),
			containment: z.enum(['advisory', 'step', 'op', 'wo']).default('step'),
			containmentStepId: z.number().int().positive().nullish(),
			assignedToId: z.number().int().positive().nullish()
		}),
		output: z.object({
			id: z.number().int(),
			issueNumber: z.string(),
			title: z.string(),
			containment: z.string(),
			executionId: z.number().int(),
			stepId: z.number().int()
		}),
		access: 'signed-in',
		mcp: true
	}),
	consumptions: op({
		name: 'execution.consumptions',
		method: 'GET',
		path: '/executions/:id/consumptions',
		summary: 'Every consume move of the execution.',
		input: z.object({ id: zId }),
		output: z.array(zDocConsumption),
		access: 'signed-in',
		mcp: true
	}),
	stepConsumptions: op({
		name: 'execution.stepConsumptions',
		method: 'GET',
		path: '/executions/:id/steps/:stepId/consumptions',
		summary: 'Consume moves booked at one step.',
		input: z.object(zStepPath),
		output: z.array(zDocConsumption),
		access: 'signed-in',
		mcp: true
	}),
	kit: op({
		name: 'execution.kit',
		method: 'GET',
		path: '/executions/:id/kit',
		summary: 'Check the snapshot kit against live stock, with the stock records to draw from.',
		input: z.object({ id: zId }),
		output: zKitAvailability,
		access: 'signed-in',
		mcp: true
	}),
	consume: op({
		name: 'execution.consume',
		method: 'POST',
		path: '/executions/:id/consume',
		summary: 'Consume stock for the execution as a whole (procedure level).',
		input: z.object({ id: zId, items: z.array(zConsumeLine).min(1), notes: z.string().nullish() }),
		output: z.array(zConsumptionRow),
		access: 'signed-in',
		mcp: true
	}),
	consumeAtStep: op({
		name: 'execution.consumeAtStep',
		method: 'POST',
		path: '/executions/:id/steps/:stepId/consume',
		summary: 'Consume stock at one step. Tooling is booked and returned (a zero move).',
		input: z.object({ ...zStepPath, items: z.array(zConsumeLine).min(1), notes: z.string().nullish() }),
		output: z.array(zConsumptionRow),
		access: 'signed-in',
		mcp: true
	}),
	outputs: op({
		name: 'execution.outputs',
		method: 'GET',
		path: '/executions/:id/outputs',
		summary: 'The outputs the snapshot expects.',
		input: z.object({ id: zId }),
		output: z.array(zOutputRow),
		access: 'signed-in',
		mcp: true
	}),
	produce: op({
		name: 'execution.produce',
		method: 'POST',
		path: '/executions/:id/produce',
		summary: 'Produce output items now: a new stock record and a produce move linked to the execution.',
		input: z.object({
			id: zId,
			items: z
				.array(
					z.object({
						partId: zId,
						quantity: zQty,
						location: z.string().trim().min(1),
						lotNumber: z.string().nullish(),
						serialNumber: z.string().nullish()
					})
				)
				.min(1),
			notes: z.string().nullish()
		}),
		output: z.array(zProductionRow),
		access: 'signed-in',
		mcp: true
	}),
	productions: op({
		name: 'execution.productions',
		method: 'GET',
		path: '/executions/:id/productions',
		summary: 'Planned, in-work and completed production of the execution.',
		input: z.object({ id: zId }),
		output: z.array(zProductionRow),
		access: 'signed-in',
		mcp: true
	}),
	bom: op({
		name: 'execution.bom',
		method: 'GET',
		path: '/executions/:id/bom',
		summary: 'BOM reconciliation: kit against what was consumed, unplanned consumption, outputs.',
		input: z.object({ id: zId }),
		output: zBomReconciliation,
		access: 'signed-in',
		mcp: true
	}),
	finalize: op({
		name: 'execution.finalize',
		method: 'POST',
		path: '/executions/:id/finalize',
		summary:
			'After completion: book the planned outputs into stock at a location and record the genealogy of the consumed components.',
		input: z.object({ id: zId, location: z.string().trim().min(1), notes: z.string().nullish() }),
		output: z.object({ executionId: z.number().int(), productions: z.array(zProductionRow) }),
		access: 'signed-in',
		mcp: true
	}),
	createRedline: op({
		name: 'execution.createRedline',
		method: 'POST',
		path: '/executions/:id/redlines',
		summary:
			'Insert a redline (ad-hoc) OP into a running execution for an open non-conformance raised at a step. It gates the host OP.',
		input: z.object({
			id: zId,
			issueId: zId,
			title: z.string().trim().min(1).max(255),
			steps: z.array(zRedlineStepInput).min(1)
		}),
		output: zRedline,
		access: 'signed-in',
		mcp: true
	}),
	listRedlines: op({
		name: 'execution.listRedlines',
		method: 'GET',
		path: '/executions/:id/redlines',
		summary: 'Redline OPs of the execution.',
		input: z.object({ id: zId }),
		output: z.array(zRedline),
		access: 'signed-in',
		mcp: true
	}),
	deleteRedline: op({
		name: 'execution.deleteRedline',
		method: 'DELETE',
		path: '/executions/:id/redlines/:redlineId',
		summary: 'Delete a redline OP (by its step id) and its steps, only while nothing in it started.',
		input: z.object({ id: zId, redlineId: zId }),
		output: zOk,
		access: 'signed-in',
		mcp: true
	})
};
