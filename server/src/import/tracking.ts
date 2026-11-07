/**
 * issue, issue_comment, issue_reference, risk_issue_link, risk, risk_reference, requirement,
 * part_requirements, baseline_event, baseline_event_item, dataset, data_point, notification.
 *
 * Every issue, risk, requirement, baseline event and dataset joins the one imported project.
 */
import {
	canonicalDesignator,
	CONTAINMENTS,
	DISPOSITION_TYPES,
	ISSUE_PRIORITIES,
	ISSUE_TYPES,
	NOTIFICATION_KINDS,
	NOTIFICATION_PRIORITIES,
	RECORDED_DISPOSITION_TYPES,
	REQUIREMENT_ALLOCATION_STATUSES,
	REQUIREMENT_LIFECYCLE_STATES,
	REQUIREMENT_VERIFICATION_METHODS,
	RISK_DISPOSITIONS,
	RISK_ISSUE_ROLES,
	RISK_REFERENCE_TYPES,
	type DatasetSchema,
	type PointValues,
	zDatasetSchema,
	zPointValue,
	zSchemaField
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
	leaveInLegacyRow,
	num,
	numberBook,
	oneOf,
	readTable,
	ref,
	str,
	track,
	ts,
	tsReq,
	warn
} from './context.ts';

type DispositionRecord = (typeof RECORDED_DISPOSITION_TYPES)[number];

const clamp5 = (c: ImportCtx, v: unknown, what: string): number => {
	const n = Math.round(Number(v));
	if (n >= 1 && n <= 5) return n;
	warn(c, `${what}: ${String(v)} is outside 1..5, clamped`);
	return Math.min(5, Math.max(1, Number.isFinite(n) ? n : 3));
};

/**
 * A disposition is what someone signed, so nothing here chooses one for them. 1.x had a type OPAL 2 has
 * not, `other`, and a signed one stays that, read as it was signed. One that nobody signed is pencil: the
 * type waits for a person, and what the old row said stays beside the rationale.
 */
function dispositionOf(c: ImportCtx, id: number, r: Row): { dispositionType: DispositionRecord | null; dispositionRationale: string | null } {
	const rationale = str(r.disposition_rationale);
	if (!r.disposition_type) return { dispositionType: null, dispositionRationale: rationale };
	const value = String(r.disposition_type).toLowerCase();
	if ((DISPOSITION_TYPES as readonly string[]).includes(value)) return { dispositionType: value as DispositionRecord, dispositionRationale: rationale };
	const said = `1.x disposition: ${String(r.disposition_type)}`;
	const signed = !!r.dispositioned_at;
	warn(c, `issue ${id}: disposition "${String(r.disposition_type)}" has no match in OPAL 2, ${signed ? 'kept as signed and shown as other' : 'not signed, so the type is left for a person'}`);
	return {
		dispositionType: signed ? 'other' : null,
		dispositionRationale: value === 'other' && signed ? rationale : rationale ? `${said}. ${rationale}` : said
	};
}

export function importIssues(c: ImportCtx): void {
	const issues = readTable(c, 'issue', ['id', 'issue_number', 'title', 'description', 'issue_type', 'status', 'priority', 'containment', 'containment_step_id', 'should_be', 'actual', 'steps_to_reproduce', 'expected_behavior', 'actual_behavior', 'expected_benefit', 'root_cause', 'corrective_action', 'disposition_type', 'disposition_rationale', 'dispositioned_at', 'work_started_at', 'work_started_by_id', 'review_requested_at', 'review_requested_by_id', 'closed_at', 'closed_by_id', 'part_id', 'procedure_instance_id', 'raised_step_id', 'raised_by_id', 'assigned_to_id', 'dispositioned_by_id', 'created_at', 'updated_at', 'deleted_at', 'procedure_id']);
	const issueNumber = numberBook(c, 'issue', canonicalDesignator);
	const rows = issues.map((r) => {
		const id = Number(r.id);
		const deleted = ts(r.deleted_at);
		const closed = String(r.status) === 'closed';
		if (!['open', 'closed'].includes(String(r.status))) warn(c, `issue ${id}: status "${String(r.status)}" is not in OPAL 2, reads as open`);
		if (r.procedure_id && !r.procedure_instance_id) {
			warn(c, `issue ${id}: named procedure ${Number(r.procedure_id)} and no work order. An issue here has no procedure, so the link is in legacy_row`);
			keepLegacyRow(c, 'issue', { id, procedure_id: r.procedure_id }, 'issue named a procedure but no work order; the new issue has no procedure column');
		}
		return {
			id,
			issueNumber: issueNumber(id, String(r.issue_number)),
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
			...dispositionOf(c, id, r),
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
	for (const r of refs) leaveInLegacyRow(c, 'issue_reference', r, 'the new issue has no reference table');
}

export function importRisks(c: ImportCtx): void {
	const risks = readTable(c, 'risk', ['id', 'risk_number', 'title', 'description', 'condition', 'departure', 'asset_part_id', 'asset_text', 'consequence', 'disposition', 'owner_id', 'probability', 'impact', 'residual_probability', 'residual_impact', 'accepted_by_id', 'accepted_at', 'acceptance_rationale', 'watch_observable', 'watch_threshold', 'watch_contingency', 'last_reviewed_at', 'last_reviewed_by_id', 'realized_issue_id', 'created_at', 'updated_at', 'deleted_at']);
	const riskNumber = numberBook(c, 'risk', canonicalDesignator);
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
			riskNumber: riskNumber(id, String(r.risk_number)),
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
	const reqNumber = numberBook(c, 'requirement', canonicalDesignator);
	const rows = reqs.map((r) => {
		const id = Number(r.id);
		const state = r.deleted_at ? ('cancelled' as const) : oneOf(c, r.lifecycle_state, REQUIREMENT_LIFECYCLE_STATES, 'draft', `requirement ${id} lifecycle_state`);
		const method = r.verification_method ? oneOf(c, r.verification_method, REQUIREMENT_VERIFICATION_METHODS, 'test', `requirement ${id} verification_method`) : null;
		const parent = num(r.parent_id);
		const sup = num(r.supersedes_id);
		return {
			id,
			reqNumber: reqNumber(id, String(r.req_number), Number(r.revision)),
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

	// Allocations: the foreign key wins; a typed REQ number resolves to its latest revision, at any width.
	const latest = new Map<string, { id: number; revision: number; statement: string }>();
	for (const r of rows) {
		const key = canonicalDesignator(r.reqNumber);
		if (!latest.has(key) || r.revision > latest.get(key)!.revision) latest.set(key, { id: r.id, revision: r.revision, statement: r.statement });
	}
	const add = addedRequirements(c, reqNumber, Math.max(0, ...rows.map((r) => r.id)));
	for (const entry of catalog(c)) {
		const have = latest.get(canonicalDesignator(entry.id));
		if (have?.statement.trim() === entry.statement.trim()) continue;
		const id = add({ number: entry.id, title: entry.title, statement: entry.statement, category: entry.category });
		if (!have) latest.set(canonicalDesignator(entry.id), { id, revision: 1, statement: entry.statement });
		else warn(c, `opal.project.yaml requirement ${entry.id} says something else than requirement ${have.id} of that number, so it is its own draft requirement`);
	}
	derived(c, 'requirement_from_project_catalog', add.count());
	const fromCatalog = add.count();
	const alloc = readTable(c, 'part_requirements', ['id', 'part_id', 'requirement_id', 'requirement_ref_id', 'status', 'notes', 'verified_at', 'verified_by_id', 'created_at', 'updated_at']);
	const seen = new Set<string>();
	const allocRows: Record<string, unknown>[] = [];
	for (const r of alloc) {
		const id = Number(r.id);
		let target = r.requirement_ref_id != null && c.ids.requirement!.has(Number(r.requirement_ref_id)) ? Number(r.requirement_ref_id) : null;
		target ??= latest.get(canonicalDesignator(String(r.requirement_id)))?.id ?? null;
		if (target === null && c.ids.part!.has(Number(r.part_id)) && str(r.requirement_id)?.trim()) {
			// 1.x took any text here. The allocation and its verification are the record: the requirement it names waits to be written.
			const number = String(r.requirement_id).trim();
			target = add({ number, title: number, statement: `OPAL 1.x allocated a part to "${number}" and held no statement for it.`, category: null });
			latest.set(canonicalDesignator(number), { id: target, revision: 1, statement: '' });
			warn(c, `part_requirements ${id}: names "${number}", which had no requirement, so a draft requirement was made for it`);
		}
		const key = `${Number(r.part_id)}/${target}`;
		if (!c.ids.part!.has(Number(r.part_id)) || target === null || seen.has(key)) {
			leaveInLegacyRow(c, 'part_requirements', r, target === null ? `requirement ${String(r.requirement_id)} does not exist` : 'part or requirement is not imported, or the pair repeats');
			warn(c, `part_requirements ${id}: kept in legacy_row (no matching requirement, or a repeated pair)`);
			continue;
		}
		seen.add(key);
		allocRows.push({ id, partId: Number(r.part_id), requirementId: target, status: oneOf(c, r.status, REQUIREMENT_ALLOCATION_STATUSES, 'open', `part_requirements ${id} status`), notes: str(r.notes), verifiedAt: ts(r.verified_at), verifiedById: ref(c, 'user', r.verified_by_id, `part_requirements ${id} verified_by_id`), createdAt: tsReq(r.created_at), updatedAt: tsReq(r.updated_at) });
	}
	insertRows(c, 'part_requirements', partRequirement, allocRows);
	derived(c, 'requirement_from_allocation', add.count() - fromCatalog);
	track(c, 'requirement', add.ids());
}

/**
 * Requirements the importer writes itself, each a draft: nobody baselined them. Before 1.4 the catalog
 * was in the project file, and part_requirements names its ids.
 */
function addedRequirements(c: ImportCtx, reqNumber: (id: number, value: string, scope?: unknown) => string, lastId: number) {
	let next = lastId;
	const made: number[] = [];
	const add = (r: { number: string; title: string; statement: string; category: string | null }): number => {
		const id = ++next;
		made.push(id);
		const at = c.report.at;
		insertRows(c, 'requirement', requirement, [{ id, reqNumber: reqNumber(id, r.number, 1), projectId: c.projectId, revision: 1, lifecycleState: 'draft', title: r.title, statement: r.statement, category: r.category, level: 0, tbd: false, tbr: false, stale: false, createdAt: at, updatedAt: at }], { count: false });
		c.ids.requirement!.add(id);
		return id;
	};
	return Object.assign(add, { count: () => made.length, ids: () => made });
}

/** The requirements listed in the project configuration, in the shape 1.x wrote them. */
function catalog(c: ImportCtx): { id: string; title: string; statement: string; category: string | null }[] {
	const row = c.src.query("SELECT value FROM app_setting WHERE key = 'project_config'").get() as { value: string | null } | null;
	const list = json<{ requirements?: unknown }>(row?.value)?.requirements;
	if (!Array.isArray(list)) return [];
	return list.flatMap((raw: unknown, i) => {
		const e = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
		const id = typeof e.id === 'string' ? e.id.trim() : '';
		if (!id) {
			warn(c, `project configuration requirement ${i + 1} has no id, left out`);
			return [];
		}
		const title = typeof e.title === 'string' && e.title.trim() ? e.title.trim() : id;
		const statement = typeof e.description === 'string' && e.description.trim() ? e.description : title;
		return [{ id, title, statement, category: typeof e.category === 'string' && e.category.trim() ? e.category.trim() : null }];
	});
}

/**
 * One unreadable schema would stop every dataset listing, and 1.x took any object here. The fields that
 * read as OPAL 2 fields stay, and the whole of what was stored stays in legacy_row.
 */
function datasetSchema(c: ImportCtx, id: number, r: Row): DatasetSchema {
	const raw = json<{ fields?: unknown }>(r.schema);
	const parsed = zDatasetSchema.safeParse(raw);
	if (parsed.success) return parsed.data;
	const names = new Set<string>();
	const fields = (Array.isArray(raw?.fields) ? raw.fields : []).flatMap((f: unknown) => {
		const one = zSchemaField.safeParse(f);
		if (!one.success || names.has(one.data.name)) return [];
		names.add(one.data.name);
		return [one.data];
	});
	if (r.schema != null) {
		warn(c, `dataset ${id}: schema does not read as OPAL 2 fields, kept ${fields.length} of them. What was stored is in legacy_row`);
		keepLegacyRow(c, 'dataset', { id, schema: r.schema }, 'schema does not read as OPAL 2 fields');
	}
	return { fields: fields.slice(0, 100) };
}

/** A point is a flat set of values, or its dataset does not open. Anything nested reads as its JSON. */
function pointValues(c: ImportCtx, id: number, value: unknown): PointValues {
	const raw = json<unknown>(value);
	if (raw === null) return {};
	if (typeof raw !== 'object' || Array.isArray(raw)) {
		warn(c, `data_point ${id}: values are not a set of fields, kept under "value"`);
		return { value: JSON.stringify(raw) };
	}
	return Object.fromEntries(Object.entries(raw).map(([k, v]) => {
		if (zPointValue.safeParse(v).success) return [k, v as PointValues[string]];
		warn(c, `data_point ${id}: value of "${k}" is nested, kept as its JSON`);
		return [k, JSON.stringify(v)];
	}));
}

export function importDatasets(c: ImportCtx): void {
	const sets = readTable(c, 'dataset', ['id', 'name', 'description', 'schema', 'procedure_id', 'created_at', 'updated_at', 'deleted_at']);
	const rows = sets.map((r) => {
		const id = Number(r.id);
		const deleted = ts(r.deleted_at);
		return {
			id,
			projectId: c.projectId,
			name: String(r.name),
			description: str(r.description),
			schema: datasetSchema(c, id, r),
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
		.map((r) => ({ id: Number(r.id), datasetId: Number(r.dataset_id), recordedAt: tsReq(r.recorded_at), values: pointValues(c, Number(r.id), r.values), stepExecutionId: num(r.step_execution_id), createdAt: tsReq(r.created_at) })));
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
