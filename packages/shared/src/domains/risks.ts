/**
 * Contracts for the risks area: scenario-structured risks (NASA/SP-2011-3422 4.2.1.1),
 * dispositions, acceptance, the scenario lint, the matrix, and links to issues.
 */
import { z } from 'zod';
import { op, zId, zOk } from '../op.ts';
import { zTimestamp } from '../time.ts';

/** CRM dispositions (elevate omitted). `accepted` is reachable only through `risks.accept`. */
export const RISK_DISPOSITIONS = [
	'open',
	'mitigate',
	'watch',
	'research',
	'accepted',
	'closed',
	'realized'
] as const;
/** What a linked issue is to the risk. A realized risk points at its issue by a dedicated column. */
export const RISK_ISSUE_ROLES = ['mitigation', 'research'] as const;
export const RISK_SEVERITIES = ['low', 'medium', 'high'] as const;
export const RISK_REFERENCE_TYPES = ['opal', 'work_order'] as const;
export const RISK_SORT_KEYS = [
	'riskNumber',
	'title',
	'disposition',
	'score',
	'residualScore',
	'reviewed',
	'created'
] as const;
/** Dispositions that count as live exposure: the matrix and `active` lists use them. */
export const RISK_LIVE_DISPOSITIONS = ['open', 'mitigate', 'watch', 'research', 'accepted'] as const;
/** Changing any of these on an accepted risk withdraws the acceptance (the signature states the score). */
export const RISK_SIGNATURE_FIELDS = [
	'condition',
	'departure',
	'assetPartId',
	'assetText',
	'consequence',
	'probability',
	'impact'
] as const;
export const RISK_PROBABILITY_LABELS = [
	'1 - Rare',
	'2 - Unlikely',
	'3 - Possible',
	'4 - Likely',
	'5 - Almost Certain'
] as const;
export const RISK_IMPACT_LABELS = [
	'1 - Negligible',
	'2 - Minor',
	'3 - Moderate',
	'4 - Major',
	'5 - Severe'
] as const;

export type RiskDisposition = (typeof RISK_DISPOSITIONS)[number];
export type RiskIssueRole = (typeof RISK_ISSUE_ROLES)[number];
export type RiskSeverity = (typeof RISK_SEVERITIES)[number];

/** Severity bucket for a 1-25 score: 1-5 low, 6-12 medium, 13-25 high. */
export function riskSeverityFor(score: number): RiskSeverity {
	return score <= 5 ? 'low' : score <= 12 ? 'medium' : 'high';
}

const zScale = z.number().int().min(1).max(5);
const zText = z.string().nullable().optional();

export const zRiskLinkedIssue = z.object({
	linkId: z.number().int(),
	issueId: z.number().int(),
	issueNumber: z.string(),
	title: z.string(),
	status: z.string(),
	role: z.enum(RISK_ISSUE_ROLES)
});
export type RiskLinkedIssue = z.infer<typeof zRiskLinkedIssue>;

export const zRiskReference = z.object({
	id: z.number().int(),
	type: z.enum(RISK_REFERENCE_TYPES),
	value: z.string(),
	notes: z.string().nullable()
});
export type RiskReference = z.infer<typeof zRiskReference>;

export const zRisk = z.object({
	id: z.number().int(),
	riskNumber: z.string(),
	projectId: z.number().int(), // added by projects
	projectCode: z.string(), // added by projects
	projectName: z.string(), // added by projects
	title: z.string(),
	description: z.string().nullable(),
	condition: z.string().nullable(),
	departure: z.string().nullable(),
	assetPartId: z.number().int().nullable(),
	assetText: z.string().nullable(),
	consequence: z.string().nullable(),
	assetDisplay: z.string().nullable(),
	assetPartNumber: z.string().nullable(),
	assetPartName: z.string().nullable(),
	/** Generated from the scenario; null until the scenario is complete. */
	statement: z.string().nullable(),
	disposition: z.enum(RISK_DISPOSITIONS),
	ownerId: z.number().int().nullable(),
	ownerName: z.string().nullable(),
	probability: z.number().int(),
	impact: z.number().int(),
	score: z.number().int(),
	severity: z.enum(RISK_SEVERITIES),
	residualProbability: z.number().int().nullable(),
	residualImpact: z.number().int().nullable(),
	residualScore: z.number().int().nullable(),
	residualSeverity: z.enum(RISK_SEVERITIES).nullable(),
	acceptedById: z.number().int().nullable(),
	acceptedByName: z.string().nullable(),
	acceptedAt: zTimestamp.nullable(),
	acceptanceRationale: z.string().nullable(),
	watchObservable: z.string().nullable(),
	watchThreshold: z.string().nullable(),
	watchContingency: z.string().nullable(),
	lastReviewedAt: zTimestamp.nullable(),
	lastReviewedById: z.number().int().nullable(),
	lastReviewedByName: z.string().nullable(),
	realizedIssueId: z.number().int().nullable(),
	realizedIssueNumber: z.string().nullable(),
	linkedIssues: z.array(zRiskLinkedIssue),
	references: z.array(zRiskReference),
	/** True only on the answer to an update that withdrew an acceptance. */
	acceptanceInvalidated: z.boolean(),
	createdAt: zTimestamp,
	updatedAt: zTimestamp
});
export type Risk = z.infer<typeof zRisk>;

/** Booleans arrive as "true", "false" or "1" in query strings. */
const zFlag = z.preprocess(
	(v) => (v === '1' || v === 'true' ? true : v === '0' || v === 'false' ? false : v),
	z.boolean()
);

/** Filters shared by the list and the bulk review stamp. */
export const zRiskFilters = z.object({
	q: z.string().optional(),
	projectId: zId.optional(), // added by projects
	disposition: z.enum(RISK_DISPOSITIONS).optional(),
	severity: z.enum(RISK_SEVERITIES).optional(),
	minScore: z.coerce.number().int().min(1).max(25).optional(),
	ownerId: zId.optional(),
	probability: z.coerce.number().int().min(1).max(5).optional(),
	impact: z.coerce.number().int().min(1).max(5).optional(),
	residualProbability: z.coerce.number().int().min(1).max(5).optional(),
	residualImpact: z.coerce.number().int().min(1).max(5).optional(),
	/** Only live exposure: not closed, not realized. */
	active: zFlag.optional()
});
export type RiskFilters = z.infer<typeof zRiskFilters>;

export const zRiskCreate = z.object({
	projectId: zId, // added by projects
	title: z.string().trim().min(1).max(255),
	description: zText,
	condition: zText,
	departure: zText,
	assetPartId: zId.nullable().optional(),
	/** Exactly one of assetPartId and assetText names the asset. */
	assetText: z.string().max(255).nullable().optional(),
	consequence: zText,
	ownerId: zId.nullable().optional(),
	probability: zScale.default(3),
	impact: zScale.default(3),
	residualProbability: zScale.nullable().optional(),
	residualImpact: zScale.nullable().optional(),
	watchObservable: z.string().max(255).nullable().optional(),
	watchThreshold: z.string().max(255).nullable().optional(),
	watchContingency: zText
});

/** Absent fields stay. Explicit null clears. `disposition` is absent: use `risks.setDisposition`. */
export const zRiskUpdate = z.object({
	id: zId,
	projectId: zId.optional(), // added by projects
	title: z.string().trim().min(1).max(255).optional(),
	description: zText,
	condition: zText,
	departure: zText,
	assetPartId: zId.nullable().optional(),
	assetText: z.string().max(255).nullable().optional(),
	consequence: zText,
	ownerId: zId.nullable().optional(),
	probability: zScale.optional(),
	impact: zScale.optional(),
	residualProbability: zScale.nullable().optional(),
	residualImpact: zScale.nullable().optional(),
	acceptanceRationale: zText,
	watchObservable: z.string().max(255).nullable().optional(),
	watchThreshold: z.string().max(255).nullable().optional(),
	watchContingency: zText
});

export const zRiskLintFinding = z.object({
	rule: z.string(),
	name: z.string(),
	severity: z.enum(['warn', 'block_accept']),
	message: z.string(),
	/** [start, end) into the field's text. */
	span: z.tuple([z.number().int(), z.number().int()]).nullable()
});
export type RiskLintFinding = z.infer<typeof zRiskLintFinding>;

/** A run of lint-checked text. `severity` is block, warn, or null for an unflagged run. */
export const zRiskLintSegment = z.object({
	text: z.string(),
	severity: z.enum(['block', 'warn']).nullable(),
	findings: z.array(z.object({ rule: z.string(), message: z.string() }))
});
export type RiskLintSegment = z.infer<typeof zRiskLintSegment>;

const zLintFields = z.object({
	condition: z.string().nullable().optional(),
	departure: z.string().nullable().optional(),
	consequence: z.string().nullable().optional()
});
const zByField = <T extends z.ZodType>(t: T) =>
	z.object({ condition: t, departure: t, consequence: t });

export const zRiskReadinessCheck = z.object({
	key: z.string(),
	label: z.string(),
	passed: z.boolean(),
	severity: z.literal('hard'),
	detail: z.string().nullable()
});
export const zRiskReadiness = z.object({ ready: z.boolean(), checks: z.array(zRiskReadinessCheck) });
export type RiskReadiness = z.infer<typeof zRiskReadiness>;

export const zRiskHistoryRow = z.object({
	at: zTimestamp,
	by: z.string().nullable(),
	action: z.enum(['create', 'update']),
	changes: z.array(
		z.object({
			field: z.string(),
			from: z.union([z.string(), z.number()]).nullable(),
			to: z.union([z.string(), z.number()]).nullable()
		})
	),
	note: z.string().nullable()
});
export type RiskHistoryRow = z.infer<typeof zRiskHistoryRow>;

export const zRiskMatrix = z.object({
	/** [probability - 1][impact - 1]: live risks at the current score. */
	matrix: z.array(z.array(z.number().int())),
	/** Same indexing: live risks at the residual target. */
	residualMatrix: z.array(z.array(z.number().int())),
	labels: z.object({
		probability: z.array(z.string()),
		impact: z.array(z.string())
	}),
	totalRisks: z.number().int()
});
export type RiskMatrix = z.infer<typeof zRiskMatrix>;

const idParam = { id: zId };

export const risks = {
	// Static paths come before `/risks/:id` so they are never read as an id.
	matrix: op({
		name: 'risks.matrix',
		method: 'GET',
		path: '/risks/matrix',
		summary: 'Matrix counts of live risks: current and residual, by probability and impact.',
		input: z.object({ projectId: zId.optional() }),
		output: zRiskMatrix,
		access: 'signed-in',
		mcp: true
	}),
	lint: op({
		name: 'risks.lint',
		method: 'POST',
		path: '/risks/lint',
		summary:
			'Lint scenario text before saving. Findings and underline runs per field. Nothing here blocks a save.',
		input: zLintFields,
		output: z.object({
			findings: zByField(z.array(zRiskLintFinding)),
			segments: zByField(z.array(zRiskLintSegment)),
			wouldBlockAccept: z.boolean()
		}),
		access: 'signed-in',
		mcp: true
	}),
	reviewStamp: op({
		name: 'risks.reviewStamp',
		method: 'POST',
		path: '/risks/review-stamp',
		summary:
			'Stamp "reviewed now, by me" on the listed risks, or on every risk matching the filters. Human only.',
		input: zRiskFilters.extend({ riskIds: z.array(zId).min(1).optional() }),
		output: z.object({ stamped: z.number().int(), reviewedAt: zTimestamp }),
		access: 'signed-in',
		mcp: true,
		humanOnly: true
	}),
	list: op({
		name: 'risks.list',
		method: 'GET',
		path: '/risks',
		summary: 'List risks. Default order: highest score first. `cursor` is an opaque offset.',
		input: zRiskFilters.extend({
			sort: z.enum(RISK_SORT_KEYS).default('score'),
			dir: z.enum(['asc', 'desc']).default('desc'),
			cursor: z.string().optional(),
			limit: z.coerce.number().int().min(1).max(500).default(50)
		}),
		output: z.object({
			items: z.array(zRisk),
			next: z.string().nullable(),
			total: z.number().int()
		}),
		access: 'signed-in',
		mcp: true
	}),
	create: op({
		name: 'risks.create',
		method: 'POST',
		path: '/risks',
		summary: 'Create a risk (disposition open). The risk number is generated.',
		input: zRiskCreate,
		output: zRisk,
		access: 'signed-in',
		mcp: true
	}),
	get: op({
		name: 'risks.get',
		method: 'GET',
		path: '/risks/:id',
		summary: 'Get one risk with its statement, linked issues and references.',
		input: z.object(idParam),
		output: zRisk,
		access: 'signed-in',
		mcp: true
	}),
	update: op({
		name: 'risks.update',
		method: 'PATCH',
		path: '/risks/:id',
		summary:
			'Update a risk. Changing the scenario or score of an accepted risk withdraws the acceptance (the risk returns to open).',
		input: zRiskUpdate,
		output: zRisk,
		access: 'signed-in',
		mcp: true
	}),
	delete: op({
		name: 'risks.delete',
		method: 'DELETE',
		path: '/risks/:id',
		summary:
			'Delete a risk that was never accepted and never realized. Others are closed instead.',
		input: z.object(idParam),
		output: zOk,
		access: 'signed-in',
		mcp: true
	}),
	readiness: op({
		name: 'risks.readiness',
		method: 'GET',
		path: '/risks/:id/readiness',
		summary: 'Acceptance readiness checks. They are exactly what `risks.accept` enforces.',
		input: z.object(idParam),
		output: zRiskReadiness,
		access: 'signed-in',
		mcp: true
	}),
	dispositionCheck: op({
		name: 'risks.dispositionCheck',
		method: 'GET',
		path: '/risks/:id/disposition-check',
		summary: 'What blocks a disposition change, with live counts of open response issues.',
		input: z.object({ ...idParam, target: z.string() }),
		output: z.object({
			target: z.string(),
			blockers: z.array(z.string()),
			openMitigations: z.number().int(),
			openResearch: z.number().int(),
			needsNote: z.boolean()
		}),
		access: 'signed-in',
		mcp: true
	}),
	history: op({
		name: 'risks.history',
		method: 'GET',
		path: '/risks/:id/history',
		summary: 'Score, residual, disposition and owner changes from the audit log, newest first.',
		input: z.object(idParam),
		output: z.array(zRiskHistoryRow),
		access: 'signed-in',
		mcp: true
	}),
	setDisposition: op({
		name: 'risks.setDisposition',
		method: 'POST',
		path: '/risks/:id/disposition',
		summary:
			'Change the disposition. A 409 names each unmet requirement. `accepted` is reachable only through `risks.accept`.',
		input: z.object({
			...idParam,
			disposition: z.enum(RISK_DISPOSITIONS),
			note: z.string().nullable().optional(),
			/** For `realized`: the issue the departure became. */
			realizedIssueId: zId.nullable().optional()
		}),
		output: zRisk,
		access: 'signed-in',
		mcp: true
	}),
	accept: op({
		name: 'risks.accept',
		method: 'POST',
		path: '/risks/:id/accept',
		summary: 'Accept the risk: the signature. Needs a complete readiness panel. Human only.',
		input: z.object({ ...idParam, rationale: z.string().nullable().optional() }),
		output: zRisk,
		access: 'signed-in',
		mcp: true,
		humanOnly: true
	}),
	linkIssue: op({
		name: 'risks.linkIssue',
		method: 'POST',
		path: '/risks/:id/issues',
		summary: 'Link an existing issue to the risk as mitigation or research work.',
		input: z.object({ ...idParam, issueId: zId, role: z.enum(RISK_ISSUE_ROLES).default('mitigation') }),
		output: zRisk,
		access: 'signed-in',
		mcp: true
	}),
	spawnIssue: op({
		name: 'risks.spawnIssue',
		method: 'POST',
		path: '/risks/:id/issues/spawn',
		summary:
			'Create an issue and attach it. mitigation and research make a task and a link. realized makes a non-conformance and points the risk at it.',
		input: z.object({
			...idParam,
			role: z.enum([...RISK_ISSUE_ROLES, 'realized']),
			title: z.string().trim().min(1).max(255),
			description: zText
		}),
		output: zRisk,
		access: 'signed-in',
		mcp: true
	}),
	unlinkIssue: op({
		name: 'risks.unlinkIssue',
		method: 'DELETE',
		path: '/risks/:id/issues/:issueId',
		summary: 'Remove a link between a risk and an issue. The issue is untouched.',
		input: z.object({ ...idParam, issueId: zId }),
		output: zRisk,
		access: 'signed-in',
		mcp: true
	}),
	addReference: op({
		name: 'risks.addReference',
		method: 'POST',
		path: '/risks/:id/references',
		summary: 'Reference an OPAL number or a work order number from the risk.',
		input: z.object({
			...idParam,
			type: z.enum(RISK_REFERENCE_TYPES),
			value: z.string().trim().min(1).max(20),
			notes: zText
		}),
		output: zRisk,
		access: 'signed-in',
		mcp: true
	}),
	removeReference: op({
		name: 'risks.removeReference',
		method: 'DELETE',
		path: '/risks/:id/references/:referenceId',
		summary: 'Remove a reference from the risk.',
		input: z.object({ ...idParam, referenceId: zId }),
		output: zRisk,
		access: 'signed-in',
		mcp: true
	})
};
