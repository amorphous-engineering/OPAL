/**
 * issue, issue_comment, issue_reference, risk_issue_link, risk, risk_reference, requirement,
 * part_requirements, baseline_event, baseline_event_item, dataset, data_point, notification.
 *
 * Every issue, risk, requirement, baseline event and dataset joins the one imported project.
 */
import {
	CONTAINMENTS,
	DISPOSITION_TYPES,
	ISSUE_PRIORITIES,
	ISSUE_TYPES,
	NOTIFICATION_KINDS,
	NOTIFICATION_PRIORITIES,
	REQUIREMENT_ALLOCATION_STATUSES,
	REQUIREMENT_LIFECYCLE_STATES,
	REQUIREMENT_VERIFICATION_METHODS,
	RISK_DISPOSITIONS,
	RISK_ISSUE_ROLES,
	RISK_REFERENCE_TYPES,
	zDatasetSchema
} from '@opal/shared';
import {
	baselineEvent,
	baselineEventItem,
	dataPoint,
	dataset,
	issue,
	issueComment,
	issueLink,
	notification,
	partRequirement,
	requirement,
	risk,
	riskReference
} from '../db/schema/index.ts';
import {
	type ImportCtx,
	type Row,
	bool,
	derived,
	fail,
	insertRows,
	json,
	keep,
	keepLegacyRow,
	num,
	oneOf,
	readTable,
	ref,
	str,
	track,
	ts,
	tsReq,
	warn
} from './context.ts';

const clamp5 = (c: ImportCtx, v: unknown, what: string): number => {
	const n = Math.round(Number(v));
	if (n >= 1 && n <= 5) return n;
	warn(c, `${what}: ${String(v)} is outside 1..5, clamped`);
	return Math.min(5, Math.max(1, Number.isFinite(n) ? n : 3));
};

export function importIssues(c: ImportCtx): void {
	const issues = readTable(c, 'issue', ['id', 'issue_number', 'title', 'description', 'issue_type', 'status', 'priority', 'containment', 'containment_step_id', 'should_be', 'actual', 'steps_to_reproduce', 'expected_behavior', 'actual_behavior', 'expected_benefit', 'root_cause', 'corrective_action', 'disposition_type', 'disposition_rationale', 'dispositioned_at', 'work_started_at', 'work_started_by_id', 'review_requested_at', 'review_requested_by_id', 'closed_at', 'closed_by_id', 'part_id', 'procedure_instance_id', 'raised_step_id', 'raised_by_id', 'assigned_to_id', 'dispositioned_by_id', 'created_at', 'updated_at', 'deleted_at', 'procedure_id']);
	const rows = issues.map((r) => {
		const id = Number(r.id);
		const deleted = ts(r.deleted_at);
		const closed = String(r.status) === 'closed';
		const disp = r.disposition_type ? oneOf(c, r.disposition_type, DISPOSITION_TYPES, 'use_as_is', `issue ${id} disposition_type`) : null;
		if (r.procedure_id && !r.procedure_instance_id) keepLegacyRow(c, 'issue', { id, procedure_id: r.procedure_id }, 'issue named a procedure but no work order; the new issue has no procedure column');
		return {
			id,
			issueNumber: String(r.issue_number),
			projectId: c.projectId,
			title: String(r.title),
			description: str(r.description),
			issueType: oneOf(c, r.issue_type, ISSUE_TYPES, 'task', `issue ${id} issue_type`),
			status: deleted ? ('void' as const) : closed ? ('closed' as const) : ('open' as const),
			priority: oneOf(c, r.priority, ISSUE_PRIORITIES, 'medium', `issue ${id} priority`),
			containment: oneOf(c, r.containment, CONTAINMENTS, 'advisory', `issue ${id} containment`),
			containmentStepId: num(r.containment_step_id),
			executionId: num(r.procedure_instance_id),
			raisedStepId: num(r.raised_step_id),
			shouldBe: str(r.should_be),
			actual: str(r.actual),
			stepsToReproduce: str(r.steps_to_reproduce),
			expectedBehavior: str(r.expected_behavior),
			actualBehavior: str(r.actual_behavior),
			expectedBenefit: str(r.expected_benefit),
			rootCause: str(r.root_cause),
			correctiveAction: str(r.corrective_action),
			dispositionType: disp,
			dispositionRationale: str(r.disposition_rationale),
			dispositionedAt: ts(r.dispositioned_at),
			dispositionedById: ref(c, 'user', r.dispositioned_by_id, `issue ${id} dispositioned_by_id`),
			workStartedAt: ts(r.work_started_at),
			workStartedById: ref(c, 'user', r.work_started_by_id, `issue ${id} work_started_by_id`),
			reviewRequestedAt: ts(r.review_requested_at),
			reviewRequestedById: ref(c, 'user', r.review_requested_by_id, `issue ${id} review_requested_by_id`),
			closedAt: ts(r.closed_at) ?? (deleted && !closed ? deleted : null),
			closedById: ref(c, 'user', r.closed_by_id, `issue ${id} closed_by_id`),
			raisedById: ref(c, 'user', r.raised_by_id, `issue ${id} raised_by_id`),
			assignedToId: ref(c, 'user', r.assigned_to_id, `issue ${id} assigned_to_id`),
			createdAt: tsReq(r.created_at),
			updatedAt: tsReq(r.updated_at)
		};
	});
	track(c, 'issue', insertRows(c, 'issue', issue, rows));

	const comments = readTable(c, 'issue_comment', ['id', 'issue_id', 'user_id', 'body', 'created_at']);
	insertRows(c, 'issue_comment', issueComment, keep(c, 'issue_comment', comments, (r) => (c.ids.issue!.has(Number(r.issue_id)) ? null : 'issue is not imported'))
		.map((r) => ({ id: Number(r.id), issueId: Number(r.issue_id), userId: ref(c, 'user', r.user_id, `issue_comment ${Number(r.id)} user_id`), body: String(r.body), createdAt: tsReq(r.created_at) })));

	// Cross-references to OPAL and work order numbers have no table in the new schema.
	const refs = readTable(c, 'issue_reference', ['id', 'issue_id', 'reference_type', 'reference_value', 'notes', 'created_at', 'updated_at']);
	for (const r of refs) {
		keepLegacyRow(c, 'issue_reference', r, 'the new issue has no reference table');
		c.report.tables.issue_reference!.imported++;
	}
}

export function importRisks(c: ImportCtx): void {
	const risks = readTable(c, 'risk', ['id', 'risk_number', 'title', 'description', 'condition', 'departure', 'asset_part_id', 'asset_text', 'consequence', 'disposition', 'owner_id', 'probability', 'impact', 'residual_probability', 'residual_impact', 'accepted_by_id', 'accepted_at', 'acceptance_rationale', 'watch_observable', 'watch_threshold', 'watch_contingency', 'last_reviewed_at', 'last_reviewed_by_id', 'realized_issue_id', 'created_at', 'updated_at', 'deleted_at']);
	const rows = risks.map((r) => {
		const id = Number(r.id);
		const part = ref(c, 'part', r.asset_part_id, `risk ${id} asset_part_id`);
		let text = str(r.asset_text);
		if (part && text) {
			warn(c, `risk ${id}: has both an asset part and asset text, kept the part`);
			text = null;
		}
		const disposition = r.deleted_at && String(r.disposition) !== 'realized'
			? ('closed' as const)
			: oneOf(c, r.disposition, RISK_DISPOSITIONS, 'open', `risk ${id} disposition`);
		return {
			id,
			riskNumber: String(r.risk_number),
			projectId: c.projectId,
			title: String(r.title),
			description: str(r.description),
			condition: str(r.condition),
			departure: str(r.departure),
			assetPartId: part,
			assetText: text,
			consequence: str(r.consequence),
			disposition,
			dispositionNote: r.deleted_at ? 'Deleted before the import' : null,
			ownerId: ref(c, 'user', r.owner_id, `risk ${id} owner_id`),
			probability: clamp5(c, r.probability, `risk ${id} probability`),
			impact: clamp5(c, r.impact, `risk ${id} impact`),
			residualProbability: r.residual_probability == null ? null : clamp5(c, r.residual_probability, `risk ${id} residual_probability`),
			residualImpact: r.residual_impact == null ? null : clamp5(c, r.residual_impact, `risk ${id} residual_impact`),
			acceptedById: ref(c, 'user', r.accepted_by_id, `risk ${id} accepted_by_id`),
			acceptedAt: ts(r.accepted_at),
			acceptanceRationale: str(r.acceptance_rationale),
			watchObservable: str(r.watch_observable),
			watchThreshold: str(r.watch_threshold),
			watchContingency: str(r.watch_contingency),
			lastReviewedAt: ts(r.last_reviewed_at),
			lastReviewedById: ref(c, 'user', r.last_reviewed_by_id, `risk ${id} last_reviewed_by_id`),
			realizedIssueId: ref(c, 'issue', r.realized_issue_id, `risk ${id} realized_issue_id`),
			createdAt: tsReq(r.created_at),
			updatedAt: tsReq(r.updated_at)
		};
	});
	track(c, 'risk', insertRows(c, 'risk', risk, rows));

	const refs = readTable(c, 'risk_reference', ['id', 'risk_id', 'reference_type', 'reference_value', 'notes', 'created_at', 'updated_at']);
	insertRows(c, 'risk_reference', riskReference, keep(c, 'risk_reference', refs, (r) => (c.ids.risk!.has(Number(r.risk_id)) ? null : 'risk is not imported'))
		.map((r) => ({ id: Number(r.id), riskId: Number(r.risk_id), referenceType: oneOf(c, r.reference_type, RISK_REFERENCE_TYPES, 'opal', `risk_reference ${Number(r.id)} reference_type`), referenceValue: String(r.reference_value), notes: str(r.notes), createdAt: tsReq(r.created_at), updatedAt: tsReq(r.updated_at) })));

	// issue_link: risk links keep their ids; a part an issue pointed at (issue.part_id) follows.
	const links = readTable(c, 'risk_issue_link', ['id', 'risk_id', 'issue_id', 'role', 'created_at']);
	const riskLinks = keep(c, 'risk_issue_link', links, (r) => (c.ids.risk!.has(Number(r.risk_id)) && c.ids.issue!.has(Number(r.issue_id)) ? null : 'risk or issue is not imported'))
		.map((r) => ({ id: Number(r.id), issueId: Number(r.issue_id), partId: null, riskId: Number(r.risk_id), riskRole: oneOf(c, r.role, RISK_ISSUE_ROLES, 'mitigation', `risk_issue_link ${Number(r.id)} role`), createdAt: tsReq(r.created_at) }));
	insertRows(c, 'risk_issue_link', issueLink, riskLinks);
	let next = Math.max(0, ...links.map((l) => Number(l.id)));
	const issues = c.src.query('SELECT id, part_id, created_at FROM issue WHERE part_id IS NOT NULL ORDER BY id').all() as Row[];
	const partLinks = issues.flatMap((r) => {
		if (!c.ids.issue!.has(Number(r.id))) return [];
		if (!c.ids.part!.has(Number(r.part_id))) {
			warn(c, `issue ${Number(r.id)}: part ${Number(r.part_id)} does not exist, link skipped`);
			return [];
		}
		return [{ id: ++next, issueId: Number(r.id), partId: Number(r.part_id), riskId: null, riskRole: null, createdAt: tsReq(r.created_at) }];
	});
	derived(c, 'issue_link_part', insertRows(c, 'issue.part_id', issueLink, partLinks, { count: false }).length);
}

export function importRequirements(c: ImportCtx): void {
	const reqs = readTable(c, 'requirement', ['id', 'req_number', 'title', 'statement', 'rationale', 'category', 'parent_id', 'level', 'verification_method', 'tbd', 'tbr', 'tbr_owner_id', 'tbr_due', 'stale', 'created_at', 'updated_at', 'deleted_at', 'lifecycle_state', 'revision', 'baselined_at', 'baselined_by_id', 'supersedes_id']);
	const known = new Set(reqs.map((r) => Number(r.id)));
	const rows = reqs.map((r) => {
		const id = Number(r.id);
		const state = r.deleted_at ? ('cancelled' as const) : oneOf(c, r.lifecycle_state, REQUIREMENT_LIFECYCLE_STATES, 'draft', `requirement ${id} lifecycle_state`);
		const method = r.verification_method ? oneOf(c, r.verification_method, REQUIREMENT_VERIFICATION_METHODS, 'test', `requirement ${id} verification_method`) : null;
		const parent = num(r.parent_id);
		const sup = num(r.supersedes_id);
		return {
			id,
			reqNumber: String(r.req_number),
			projectId: c.projectId,
			revision: Number(r.revision),
			lifecycleState: state,
			title: String(r.title),
			statement: String(r.statement),
			rationale: str(r.rationale),
			category: str(r.category),
			parentId: parent !== null && known.has(parent) ? parent : null,
			level: Number(r.level),
			verificationMethod: method,
			tbd: bool(r.tbd),
			tbr: bool(r.tbr),
			tbrOwnerId: ref(c, 'user', r.tbr_owner_id, `requirement ${id} tbr_owner_id`),
			tbrDue: ts(r.tbr_due),
			stale: bool(r.stale),
			baselinedAt: ts(r.baselined_at),
			baselinedById: ref(c, 'user', r.baselined_by_id, `requirement ${id} baselined_by_id`),
			supersedesId: sup !== null && known.has(sup) ? sup : null,
			createdAt: tsReq(r.created_at),
			updatedAt: tsReq(r.updated_at)
		};
	});
	track(c, 'requirement', insertRows(c, 'requirement', requirement, rows));

	const events = readTable(c, 'baseline_event', ['id', 'label', 'note', 'signed_by_id', 'created_at']);
	track(c, 'baseline_event', insertRows(c, 'baseline_event', baselineEvent, events.map((r) => ({
		id: Number(r.id),
		projectId: c.projectId,
		label: str(r.label),
		note: str(r.note),
		signedById: ref(c, 'user', r.signed_by_id, `baseline_event ${Number(r.id)} signed_by_id`),
		createdAt: tsReq(r.created_at)
	}))));
	const created = new Map(events.map((e) => [Number(e.id), tsReq(e.created_at)]));
	const items = readTable(c, 'baseline_event_item', ['id', 'event_id', 'requirement_id']);
	insertRows(c, 'baseline_event_item', baselineEventItem, keep(c, 'baseline_event_item', items, (r) =>
		c.ids.baseline_event!.has(Number(r.event_id)) && c.ids.requirement!.has(Number(r.requirement_id)) ? null : 'event or requirement is not imported')
		.map((r) => ({ id: Number(r.id), eventId: Number(r.event_id), requirementId: Number(r.requirement_id), createdAt: created.get(Number(r.event_id))! })));

	// Allocations: the foreign key wins; a typed REQ number resolves to its latest revision.
	const latest = new Map<string, number>();
	for (const r of rows) {
		const have = latest.get(r.reqNumber);
		if (have === undefined || r.revision > (rows.find((x) => x.id === have)?.revision ?? 0)) latest.set(r.reqNumber, r.id);
	}
	const alloc = readTable(c, 'part_requirements', ['id', 'part_id', 'requirement_id', 'requirement_ref_id', 'status', 'notes', 'verified_at', 'verified_by_id', 'created_at', 'updated_at']);
	const seen = new Set<string>();
	const allocRows: Record<string, unknown>[] = [];
	for (const r of alloc) {
		const id = Number(r.id);
		let target = r.requirement_ref_id != null && c.ids.requirement!.has(Number(r.requirement_ref_id)) ? Number(r.requirement_ref_id) : null;
		target ??= latest.get(String(r.requirement_id)) ?? null;
		const key = `${Number(r.part_id)}/${target}`;
		if (!c.ids.part!.has(Number(r.part_id)) || target === null || seen.has(key)) {
			keepLegacyRow(c, 'part_requirements', r, target === null ? `requirement ${String(r.requirement_id)} does not exist` : 'part or requirement is not imported, or the pair repeats');
			warn(c, `part_requirements ${id}: kept in legacy_row (no matching requirement, or a repeated pair)`);
			continue;
		}
		seen.add(key);
		allocRows.push({ id, partId: Number(r.part_id), requirementId: target, status: oneOf(c, r.status, REQUIREMENT_ALLOCATION_STATUSES, 'open', `part_requirements ${id} status`), notes: str(r.notes), verifiedAt: ts(r.verified_at), verifiedById: ref(c, 'user', r.verified_by_id, `part_requirements ${id} verified_by_id`), createdAt: tsReq(r.created_at), updatedAt: tsReq(r.updated_at) });
	}
	insertRows(c, 'part_requirements', partRequirement, allocRows);
}

export function importDatasets(c: ImportCtx): void {
	const sets = readTable(c, 'dataset', ['id', 'name', 'description', 'schema', 'procedure_id', 'created_at', 'updated_at', 'deleted_at']);
	const rows = sets.map((r) => {
		const id = Number(r.id);
		const raw = json<unknown>(r.schema) ?? { fields: [] };
		const parsed = zDatasetSchema.safeParse(raw);
		if (!parsed.success) warn(c, `dataset ${id}: schema does not match the new schema rules, kept as stored`);
		const deleted = ts(r.deleted_at);
		return {
			id,
			projectId: c.projectId,
			name: String(r.name),
			description: str(r.description),
			schema: (parsed.success ? parsed.data : raw) as never,
			procedureId: r.procedure_id != null && c.ids.procedure?.has(Number(r.procedure_id)) ? Number(r.procedure_id) : null,
			state: deleted ? ('archived' as const) : ('active' as const),
			archivedAt: deleted,
			archivedById: null,
			createdAt: tsReq(r.created_at),
			updatedAt: tsReq(r.updated_at)
		};
	});
	track(c, 'dataset', insertRows(c, 'dataset', dataset, rows));
	const pts = readTable(c, 'data_point', ['id', 'dataset_id', 'recorded_at', 'values', 'step_execution_id', 'created_at']);
	insertRows(c, 'data_point', dataPoint, keep(c, 'data_point', pts, (r) => (c.ids.dataset!.has(Number(r.dataset_id)) ? null : 'dataset is not imported'))
		.map((r) => ({ id: Number(r.id), datasetId: Number(r.dataset_id), recordedAt: tsReq(r.recorded_at), values: json(r.values) ?? {}, stepExecutionId: num(r.step_execution_id), createdAt: tsReq(r.created_at) })));
}

export function importNotifications(c: ImportCtx): void {
	const rows = readTable(c, 'notification', ['id', 'user_id', 'actor_id', 'kind', 'priority', 'title', 'body', 'href', 'subject_type', 'subject_id', 'read_at', 'dismissed_at', 'created_at']);
	insertRows(c, 'notification', notification, rows.flatMap((r) => {
		const id = Number(r.id);
		const kind = String(r.kind);
		if (!c.ids.user!.has(Number(r.user_id))) {
			fail(c, 'notification', id, `user ${Number(r.user_id)} is not imported`);
			return [];
		}
		if (!(NOTIFICATION_KINDS as readonly string[]).includes(kind)) {
			fail(c, 'notification', id, `kind "${kind}" is not valid`);
			return [];
		}
		return [{ id, userId: Number(r.user_id), actorId: ref(c, 'user', r.actor_id, `notification ${id} actor_id`), kind: kind as (typeof NOTIFICATION_KINDS)[number], priority: oneOf(c, r.priority, NOTIFICATION_PRIORITIES, 'normal', `notification ${id} priority`), title: String(r.title), body: str(r.body), href: String(r.href), subjectType: String(r.subject_type), subjectId: Number(r.subject_id), createdAt: tsReq(r.created_at), readAt: ts(r.read_at), dismissedAt: ts(r.dismissed_at) }];
	}));
}
