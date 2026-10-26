/**
 * Contracts for the requirements area: the requirement tree and its revisions, baselining,
 * the review queue, readiness, the statement lint, the dashboard summary, the catalog import
 * and the part-requirement links.
 */
import { z } from 'zod';
import { op, zEmpty, zId, zOk, zPage, zPageInput } from '../op.ts';
import { zTimestamp } from '../time.ts';

/** draft -> preliminary -> baselined -> superseded | cancelled. Only draft and preliminary edit in place. */
export const REQUIREMENT_LIFECYCLE_STATES = ['draft', 'preliminary', 'baselined', 'superseded', 'cancelled'] as const;
export const REQUIREMENT_EDITABLE_STATES = ['draft', 'preliminary'] as const;
/** States whose row is in force or in progress (not replaced, not dropped). */
export const REQUIREMENT_LIVE_STATES = ['draft', 'preliminary', 'baselined'] as const;
export const REQUIREMENT_VERIFICATION_METHODS = ['analysis', 'inspection', 'demonstration', 'test'] as const;
/** The status of one part-requirement link. */
export const REQUIREMENT_ALLOCATION_STATUSES = ['open', 'verified', 'waived', 'not_applicable'] as const;
/** The roll-up of a requirement's links. */
export const REQUIREMENT_VERIFICATION_STATUSES = [
	'verified',
	'partial',
	'open',
	'unallocated',
	'not_applicable'
] as const;
export const REQUIREMENT_LINT_SEVERITIES = ['warn', 'block_baseline'] as const;

export type RequirementLifecycleState = (typeof REQUIREMENT_LIFECYCLE_STATES)[number];
export type RequirementVerificationMethod = (typeof REQUIREMENT_VERIFICATION_METHODS)[number];
export type RequirementAllocationStatus = (typeof REQUIREMENT_ALLOCATION_STATUSES)[number];
export type RequirementVerificationStatus = (typeof REQUIREMENT_VERIFICATION_STATUSES)[number];

/** One lint finding. `span` indexes into the statement; field-level findings carry none. */
export const zRequirementFinding = z.object({
	rule: z.string(),
	name: z.string(),
	severity: z.enum(REQUIREMENT_LINT_SEVERITIES),
	message: z.string(),
	span: z.tuple([z.number().int(), z.number().int()]).optional()
});
export type RequirementFinding = z.infer<typeof zRequirementFinding>;

export const zRequirement = z.object({
	id: z.number().int(),
	reqNumber: z.string(),
	projectId: z.number().int(), // added by projects
	projectCode: z.string(), // added by projects
	projectName: z.string(), // added by projects
	revision: z.number().int(),
	lifecycleState: z.enum(REQUIREMENT_LIFECYCLE_STATES),
	title: z.string(),
	statement: z.string(),
	rationale: z.string().nullable(),
	category: z.string().nullable(),
	parentId: z.number().int().nullable(),
	level: z.number().int(),
	verificationMethod: z.enum(REQUIREMENT_VERIFICATION_METHODS).nullable(),
	tbd: z.boolean(),
	tbr: z.boolean(),
	tbrOwnerId: z.number().int().nullable(),
	tbrDue: zTimestamp.nullable(),
	stale: z.boolean(),
	baselinedAt: zTimestamp.nullable(),
	baselinedById: z.number().int().nullable(),
	supersedesId: z.number().int().nullable(),
	childrenCount: z.number().int(),
	allocationCount: z.number().int(),
	createdAt: zTimestamp,
	updatedAt: zTimestamp
});
export type Requirement = z.infer<typeof zRequirement>;

/** Input caps. Stored rows may be longer (1.x imports), so lint and redline stay safe on any length. */
export const REQUIREMENT_STATEMENT_MAX = 4000;
export const REQUIREMENT_RATIONALE_MAX = 10000;
const text = z.string().max(REQUIREMENT_RATIONALE_MAX).nullable().optional();
const zNullableId = z.number().int().positive().nullable().optional();

export const zRequirementCreate = z.object({
	projectId: zId, // added by projects
	title: z.string().trim().min(1).max(255),
	statement: z.string().trim().min(1).max(REQUIREMENT_STATEMENT_MAX),
	rationale: text,
	category: z.string().max(50).nullable().optional(),
	parentId: zNullableId,
	/** Defaults to the parent's level + 1, or 0. */
	level: z.number().int().min(0).optional(),
	verificationMethod: z.enum(REQUIREMENT_VERIFICATION_METHODS).nullable().optional(),
	tbd: z.boolean().default(false),
	tbr: z.boolean().default(false),
	tbrOwnerId: zNullableId,
	tbrDue: zTimestamp.nullable().optional()
});

/** Absent leaves a field alone. null clears the nullable ones. */
export const zRequirementUpdate = z.object({
	id: zId,
	projectId: zId.optional(), // added by projects
	title: z.string().trim().min(1).max(255).optional(),
	statement: z.string().trim().min(1).max(REQUIREMENT_STATEMENT_MAX).optional(),
	rationale: text,
	category: z.string().max(50).nullable().optional(),
	parentId: zNullableId,
	level: z.number().int().min(0).optional(),
	verificationMethod: z.enum(REQUIREMENT_VERIFICATION_METHODS).nullable().optional(),
	tbd: z.boolean().optional(),
	tbr: z.boolean().optional(),
	tbrOwnerId: zNullableId,
	tbrDue: zTimestamp.nullable().optional(),
	/** Only draft and preliminary move here. The other states have their own operations. */
	lifecycleState: z.enum(REQUIREMENT_EDITABLE_STATES).optional()
});

export const zRequirementLintInput = z.object({
	statement: z.string().max(REQUIREMENT_STATEMENT_MAX),
	rationale: text,
	verificationMethod: z.enum(REQUIREMENT_VERIFICATION_METHODS).nullable().optional(),
	tbd: z.boolean().default(false),
	tbr: z.boolean().default(false),
	tbrOwnerId: zNullableId,
	tbrDue: zTimestamp.nullable().optional()
});

export const zRequirementLintResult = z.object({
	findings: z.array(zRequirementFinding),
	wouldBlockBaseline: z.boolean()
});
export type RequirementLintResult = z.infer<typeof zRequirementLintResult>;

// ---- tree and summary ----

export const zRequirementTreePart = z.object({
	partId: z.number().int(),
	name: z.string(),
	status: z.enum(REQUIREMENT_ALLOCATION_STATUSES)
});

export const zRequirementTreeItem = z.object({
	id: z.number().int(),
	reqNumber: z.string(),
	projectId: z.number().int(), // added by projects
	projectCode: z.string(), // added by projects
	revision: z.number().int(),
	lifecycleState: z.enum(REQUIREMENT_LIFECYCLE_STATES),
	title: z.string(),
	statement: z.string(),
	rationale: z.string().nullable(),
	level: z.number().int(),
	category: z.string().nullable(),
	verificationMethod: z.enum(REQUIREMENT_VERIFICATION_METHODS).nullable(),
	tbd: z.boolean(),
	tbr: z.boolean(),
	stale: z.boolean(),
	/** null for a root, and for a row whose parent is no longer current (`orphan`). */
	parentId: z.number().int().nullable(),
	orphan: z.boolean(),
	updatedAt: zTimestamp,
	lint: z.array(zRequirementFinding),
	parts: z.array(zRequirementTreePart),
	verification: z.enum(REQUIREMENT_VERIFICATION_STATUSES)
});
export type RequirementTreeItem = z.infer<typeof zRequirementTreeItem>;

export const zRequirementTree = z.object({
	items: z.array(zRequirementTreeItem),
	total: z.number().int(),
	queueCount: z.number().int()
});
export type RequirementTree = z.infer<typeof zRequirementTree>;

export const zRequirementRef = z.object({ id: z.number().int(), reqNumber: z.string(), title: z.string() });
export type RequirementRef = z.infer<typeof zRequirementRef>;

export const zRequirementSummary = z.object({
	total: z.number().int(),
	byState: z.record(z.string(), z.number().int()),
	coverage: z.object({
		leaves: z.number().int(),
		leavesAllocated: z.number().int(),
		withVerificationMethod: z.number().int()
	}),
	verification: z.record(z.enum(REQUIREMENT_VERIFICATION_STATUSES), z.number().int()),
	readyToBaseline: z.number().int(),
	stale: z.array(zRequirementRef),
	overdueTbrs: z.array(
		zRequirementRef.extend({ owner: z.string(), daysOver: z.number().int(), tbrDue: zTimestamp })
	),
	stuckDrafts: z.array(zRequirementRef),
	asOf: zTimestamp
});
export type RequirementSummary = z.infer<typeof zRequirementSummary>;

// ---- dossier ----

export const zRequirementCheck = z.object({
	key: z.string(),
	label: z.string(),
	passed: z.boolean(),
	severity: z.enum(['hard', 'warning']),
	detail: z.string().nullable()
});
export type RequirementCheck = z.infer<typeof zRequirementCheck>;

export const zRequirementReadiness = z.object({ ready: z.boolean(), checks: z.array(zRequirementCheck) });
export type RequirementReadiness = z.infer<typeof zRequirementReadiness>;

export const zRequirementAllocation = z.object({
	id: z.number().int(),
	partId: z.number().int(),
	partName: z.string(),
	internalPn: z.string().nullable(),
	status: z.enum(REQUIREMENT_ALLOCATION_STATUSES),
	notes: z.string().nullable(),
	verifiedAt: zTimestamp.nullable(),
	verifiedBy: z.string().nullable(),
	/** The revision the link was made against. */
	againstRevision: z.number().int(),
	/** Verified or waived against an older revision than the one in force. */
	outdated: z.boolean()
});
export type RequirementAllocation = z.infer<typeof zRequirementAllocation>;

export const zRequirementDossier = z.object({
	id: z.number().int(),
	reqNumber: z.string(),
	projectId: z.number().int(), // added by projects
	projectCode: z.string(), // added by projects
	projectName: z.string(), // added by projects
	revision: z.number().int(),
	lifecycleState: z.enum(REQUIREMENT_LIFECYCLE_STATES),
	title: z.string(),
	statement: z.string(),
	rationale: z.string().nullable(),
	category: z.string().nullable(),
	level: z.number().int(),
	parentId: z.number().int().nullable(),
	verificationMethod: z.enum(REQUIREMENT_VERIFICATION_METHODS).nullable(),
	tbd: z.boolean(),
	tbr: z.boolean(),
	tbrOwnerId: z.number().int().nullable(),
	tbrOwner: z.string().nullable(),
	tbrDue: zTimestamp.nullable(),
	stale: z.boolean(),
	baselinedAt: zTimestamp.nullable(),
	baselinedBy: z.string().nullable(),
	supersedesId: z.number().int().nullable(),
	predecessorRevision: z.number().int().nullable(),
	createdAt: zTimestamp,
	updatedAt: zTimestamp,
	parentChain: z.array(zRequirementRef),
	children: z.array(
		z.object({
			id: z.number().int(),
			reqNumber: z.string(),
			title: z.string(),
			lifecycleState: z.enum(REQUIREMENT_LIFECYCLE_STATES),
			level: z.number().int(),
			stale: z.boolean()
		})
	),
	allocations: z.array(zRequirementAllocation),
	verification: z.enum(REQUIREMENT_VERIFICATION_STATUSES),
	revisions: z.array(
		z.object({
			id: z.number().int(),
			revision: z.number().int(),
			lifecycleState: z.enum(REQUIREMENT_LIFECYCLE_STATES),
			statement: z.string(),
			baselinedAt: zTimestamp.nullable()
		})
	),
	baselineEvents: z.array(
		z.object({
			eventId: z.number().int(),
			label: z.string().nullable(),
			createdAt: zTimestamp,
			revision: z.number().int()
		})
	),
	readiness: zRequirementReadiness.nullable(),
	lint: z.array(zRequirementFinding),
	/** A draft nothing references. Everything else is cancelled or revised. */
	canDelete: z.boolean()
});
export type RequirementDossier = z.infer<typeof zRequirementDossier>;

export const zRequirementSegment = z.object({ op: z.enum(['equal', 'delete', 'insert']), text: z.string() });
export type RequirementSegment = z.infer<typeof zRequirementSegment>;

export const zRequirementRedline = z.object({
	revA: z.number().int(),
	revB: z.number().int(),
	title: z.array(zRequirementSegment),
	statement: z.array(zRequirementSegment),
	rationale: z.array(zRequirementSegment)
});
export type RequirementRedline = z.infer<typeof zRequirementRedline>;

// ---- queue and baseline events ----

export const zRequirementQueueItem = z.object({
	id: z.number().int(),
	projectId: z.number().int(), // added by projects
	reqNumber: z.string(),
	revision: z.number().int(),
	title: z.string(),
	statement: z.string(),
	rationale: z.string().nullable(),
	level: z.number().int(),
	verificationMethod: z.enum(REQUIREMENT_VERIFICATION_METHODS).nullable(),
	stale: z.boolean(),
	childrenCount: z.number().int(),
	parts: z.array(z.string()),
	chain: z.array(
		z.object({
			id: z.number().int(),
			reqNumber: z.string(),
			title: z.string(),
			lifecycleState: z.enum(REQUIREMENT_LIFECYCLE_STATES)
		})
	),
	warnings: z.array(z.string()),
	change: zRequirementRedline.nullable()
});
export type RequirementQueueItem = z.infer<typeof zRequirementQueueItem>;

export const zRequirementQueue = z.object({
	count: z.number().int(),
	ids: z.array(z.number().int()),
	items: z.array(zRequirementQueueItem)
});

export const zRequirementEventSummary = z.object({
	id: z.number().int(),
	projectId: z.number().int(), // added by projects
	projectCode: z.string(), // added by projects
	projectName: z.string(), // added by projects
	label: z.string().nullable(),
	note: z.string().nullable(),
	signedBy: z.string().nullable(),
	createdAt: zTimestamp,
	locked: z.number().int(),
	revised: z.number().int()
});
export type RequirementEventSummary = z.infer<typeof zRequirementEventSummary>;

export const zRequirementEventItem = z.object({
	id: z.number().int(),
	reqNumber: z.string(),
	revision: z.number().int(),
	title: z.string(),
	statement: z.string(),
	lifecycleState: z.enum(REQUIREMENT_LIFECYCLE_STATES),
	previousRevision: z.number().int().nullable(),
	changed: z.array(z.string()),
	diff: zRequirementRedline.nullable()
});
export type RequirementEventItem = z.infer<typeof zRequirementEventItem>;

export const zRequirementEventDetail = zRequirementEventSummary.extend({ items: z.array(zRequirementEventItem) });
export type RequirementEventDetail = z.infer<typeof zRequirementEventDetail>;

export const zRequirementBatchInput = z.object({
	ids: z.array(zId).min(1),
	label: z.string().max(100).nullable().optional(),
	note: text
});

export const zRequirementBatchResult = z.object({
	eventId: z.number().int(),
	label: z.string().nullable(),
	baselined: z.array(
		z.object({ id: z.number().int(), reqNumber: z.string(), revision: z.number().int() })
	)
});

// ---- part links ----

/** A requirement as the part page shows it. */
export const zRequirementPartRequirement = z.object({
	id: z.number().int(),
	partId: z.number().int(),
	requirementId: z.number().int(),
	reqNumber: z.string(),
	revision: z.number().int(),
	title: z.string(),
	statement: z.string(),
	category: z.string().nullable(),
	lifecycleState: z.enum(REQUIREMENT_LIFECYCLE_STATES),
	tbd: z.boolean(),
	tbr: z.boolean(),
	stale: z.boolean(),
	status: z.enum(REQUIREMENT_ALLOCATION_STATUSES),
	notes: z.string().nullable(),
	verifiedAt: zTimestamp.nullable(),
	verifiedBy: z.object({ id: z.number().int(), name: z.string() }).nullable(),
	createdAt: zTimestamp,
	updatedAt: zTimestamp
});
export type RequirementPartRequirement = z.infer<typeof zRequirementPartRequirement>;

export const zRequirementCatalogImport = z.object({
	created: z.array(z.string()),
	skipped: z.array(z.string())
});
export type RequirementCatalogResult = z.infer<typeof zRequirementCatalogImport>;

const numberFilter = z.coerce.number().int();

/** Narrows a view to one project. */ // added by projects
const zProjectScope = z.object({ projectId: zId.optional() }); // added by projects

export const requirements = {
	// Static paths are listed before `/requirements/:id` so a name is never read as an id.
	lint: op({
		name: 'requirements.lint',
		method: 'POST',
		path: '/requirements/lint',
		summary:
			'Lint requirement fields as typed. Same engine the baseline gate enforces. Needs no stored row.',
		input: zRequirementLintInput,
		output: zRequirementLintResult,
		access: 'signed-in',
		mcp: true
	}),
	tree: op({
		name: 'requirements.tree',
		method: 'GET',
		path: '/requirements/tree',
		summary:
			'Every current requirement as flat flow-down rows (nest by parentId) with parts, verification and lint. `projectId` narrows to one project.',
		input: zProjectScope, // added by projects
		output: zRequirementTree,
		access: 'signed-in',
		mcp: true
	}),
	summary: op({
		name: 'requirements.summary',
		method: 'GET',
		path: '/requirements/summary',
		summary: 'Coverage, verification and staleness roll-up, plus what is red. `projectId` narrows to one project.',
		input: zProjectScope, // added by projects
		output: zRequirementSummary,
		access: 'signed-in',
		mcp: true
	}),
	queue: op({
		name: 'requirements.queue',
		method: 'GET',
		path: '/requirements/queue',
		summary: 'The baseline queue: draft and preliminary rows whose hard checks all pass, with review context. `projectId` narrows to one project.',
		input: zProjectScope, // added by projects
		output: zRequirementQueue,
		access: 'signed-in',
		mcp: true
	}),
	baselines: op({
		name: 'requirements.baselines',
		method: 'GET',
		path: '/requirements/baselines',
		summary: 'Baseline events, newest first. `projectId` narrows to one project.',
		input: zProjectScope, // added by projects
		output: z.array(zRequirementEventSummary),
		access: 'signed-in',
		mcp: true
	}),
	baselineEvent: op({
		name: 'requirements.baselineEvent',
		method: 'GET',
		path: '/requirements/baselines/:id',
		summary: 'One baseline event: the locked revisions and what each changed.',
		input: z.object({ id: zId }),
		output: zRequirementEventDetail,
		access: 'signed-in',
		mcp: true
	}),
	baselineBatch: op({
		name: 'requirements.baselineBatch',
		method: 'POST',
		path: '/requirements/baseline-batch',
		summary:
			'Baseline a set in one event. Every item is checked again first. One failure aborts the whole batch.',
		input: zRequirementBatchInput,
		output: zRequirementBatchResult,
		access: 'signed-in',
		mcp: true,
		humanOnly: true
	}),
	importCatalog: op({
		name: 'requirements.importCatalog',
		method: 'POST',
		path: '/requirements/import',
		summary:
			'Import the organization requirement catalog into a project as level-0 draft requirements. Numbers already present are skipped.',
		input: z.object({ projectId: zId }), // added by projects
		output: zRequirementCatalogImport,
		access: 'admin',
		mcp: false
	}),
	catalog: op({
		name: 'requirements.catalog',
		method: 'GET',
		path: '/requirements/catalog',
		summary: 'Catalog entries that are not yet requirements. Empty before the organization is set up.',
		input: zEmpty,
		output: z.array(zRequirementRef),
		access: 'signed-in',
		mcp: false
	}),
	byNumber: op({
		name: 'requirements.byNumber',
		method: 'GET',
		path: '/requirements/number/:reqNumber',
		summary: 'The current revision of a requirement by its REQ number.',
		input: z.object({ reqNumber: z.string() }),
		output: zRequirement,
		access: 'signed-in',
		mcp: true
	}),
	list: op({
		name: 'requirements.list',
		method: 'GET',
		path: '/requirements',
		summary: 'List requirements. Superseded revisions are hidden unless asked for.',
		input: zPageInput.extend({
			projectId: zId.optional(), // added by projects
			state: z.enum(REQUIREMENT_LIFECYCLE_STATES).optional(),
			category: z.string().optional(),
			level: numberFilter.optional(),
			parentId: zId.optional(),
			q: z.string().optional(),
			includeSuperseded: z
				.enum(['true', 'false'])
				.transform((v) => v === 'true')
				.optional()
		}),
		output: zPage(zRequirement).extend({ total: z.number().int() }),
		access: 'signed-in',
		mcp: true
	}),
	create: op({
		name: 'requirements.create',
		method: 'POST',
		path: '/requirements',
		summary: 'Create a draft requirement with the next REQ number.',
		input: zRequirementCreate,
		output: zRequirement,
		access: 'signed-in',
		mcp: true
	}),
	get: op({
		name: 'requirements.get',
		method: 'GET',
		path: '/requirements/:id',
		summary: 'Get one requirement revision.',
		input: z.object({ id: zId }),
		output: zRequirement,
		access: 'signed-in',
		mcp: true
	}),
	update: op({
		name: 'requirements.update',
		method: 'PATCH',
		path: '/requirements/:id',
		summary:
			'Edit a draft or preliminary requirement in place. A baselined row is immutable: revise it. Any edit clears the stale flag.',
		input: zRequirementUpdate,
		output: zRequirement,
		access: 'signed-in',
		mcp: true
	}),
	delete: op({
		name: 'requirements.delete',
		method: 'DELETE',
		path: '/requirements/:id',
		summary:
			'Delete a draft or preliminary requirement that has no children and no part links. Others are cancelled or revised.',
		input: z.object({ id: zId }),
		output: zOk,
		access: 'signed-in',
		mcp: true
	}),
	baseline: op({
		name: 'requirements.baseline',
		method: 'POST',
		path: '/requirements/:id/baseline',
		summary:
			'Baseline one requirement and record a baseline event. Refused with the list of blockers when it is not ready.',
		input: z.object({ id: zId }),
		output: zRequirement,
		access: 'signed-in',
		mcp: true,
		humanOnly: true
	}),
	revise: op({
		name: 'requirements.revise',
		method: 'POST',
		path: '/requirements/:id/revise',
		summary: 'Create the next draft revision of a baselined requirement.',
		input: z.object({ id: zId }),
		output: zRequirement,
		access: 'signed-in',
		mcp: true
	}),
	cancel: op({
		name: 'requirements.cancel',
		method: 'POST',
		path: '/requirements/:id/cancel',
		summary: 'Cancel a requirement (terminal).',
		input: z.object({ id: zId }),
		output: zRequirement,
		access: 'signed-in',
		mcp: true
	}),
	reaffirm: op({
		name: 'requirements.reaffirm',
		method: 'POST',
		path: '/requirements/:id/reaffirm',
		summary: 'Clear the stale flag without an edit: the parent change does not invalidate this row.',
		input: z.object({ id: zId }),
		output: zRequirement,
		access: 'signed-in',
		mcp: true,
		humanOnly: true
	}),
	dossier: op({
		name: 'requirements.dossier',
		method: 'GET',
		path: '/requirements/:id/dossier',
		summary: 'Everything the requirement page shows: flow-down, parts, revisions, readiness, lint.',
		input: z.object({ id: zId }),
		output: zRequirementDossier,
		access: 'signed-in',
		mcp: true
	}),
	redline: op({
		name: 'requirements.redline',
		method: 'GET',
		path: '/requirements/:id/redline',
		summary:
			'Word diff between two revisions of this number. Defaults to this revision against the one it supersedes.',
		input: z.object({ id: zId, revA: numberFilter.optional(), revB: numberFilter.optional() }),
		output: zRequirementRedline,
		access: 'signed-in',
		mcp: true
	}),
	readiness: op({
		name: 'requirements.readiness',
		method: 'GET',
		path: '/requirements/:id/readiness',
		summary: 'Baseline readiness as structured checks.',
		input: z.object({ id: zId }),
		output: zRequirementReadiness,
		access: 'signed-in',
		mcp: true
	}),
	revisions: op({
		name: 'requirements.revisions',
		method: 'GET',
		path: '/requirements/:id/revisions',
		summary: 'All revisions that share this requirement number, oldest first.',
		input: z.object({ id: zId }),
		output: z.array(zRequirement),
		access: 'signed-in',
		mcp: true
	}),
	forPart: op({
		name: 'requirements.forPart',
		method: 'GET',
		path: '/requirements/parts/:partId',
		summary: 'Requirements linked to a part.',
		input: z.object({ partId: zId }),
		output: z.array(zRequirementPartRequirement),
		access: 'signed-in',
		mcp: true
	}),
	assign: op({
		name: 'requirements.assign',
		method: 'POST',
		path: '/requirements/parts/:partId',
		summary: 'Link a requirement to a part by REQ number. The current revision is linked.',
		input: z.object({
			partId: zId,
			reqNumber: z.string().trim().min(1),
			notes: text
		}),
		output: zRequirementPartRequirement,
		access: 'signed-in',
		mcp: true
	}),
	updateLink: op({
		name: 'requirements.updateLink',
		method: 'PATCH',
		path: '/requirements/allocations/:id',
		summary: 'Set the status or notes of a part-requirement link.',
		input: z.object({
			id: zId,
			status: z.enum(REQUIREMENT_ALLOCATION_STATUSES).optional(),
			notes: text
		}),
		output: zRequirementPartRequirement,
		access: 'signed-in',
		mcp: true
	}),
	verifyLink: op({
		name: 'requirements.verifyLink',
		method: 'POST',
		path: '/requirements/allocations/:id/verify',
		summary: 'Mark a part-requirement link verified, by the caller, now.',
		input: z.object({ id: zId, notes: text }),
		output: zRequirementPartRequirement,
		access: 'signed-in',
		mcp: true
	}),
	unassign: op({
		name: 'requirements.unassign',
		method: 'DELETE',
		path: '/requirements/allocations/:id',
		summary: 'Remove a requirement link from a part.',
		input: z.object({ id: zId }),
		output: zOk,
		access: 'signed-in',
		mcp: true
	})
};
