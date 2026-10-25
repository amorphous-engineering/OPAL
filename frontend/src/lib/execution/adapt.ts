/**
 * The execution document from the contract (camelCase, step execution ids) into the view model
 * the procedure-doc components render (snake_case, `order` as the step key). The components are
 * shared with template authoring, so the view model stays theirs; this is the one place that
 * knows both shapes. A step's `order` is its step execution id.
 */
import type {
	DocOpOut,
	DocStepOut,
	ExecutionDocument as ApiDocument,
	ExecutionState as ApiState
} from '@opal/shared';
import type { DocOp, DocStep } from '#lib/components/procedure-doc/index.js';
import type { ExecutionDocument, ExecutionState } from './types.js';

const num = (q: string) => Number(q);
const person = (p: { id: number; name: string; avatarUrl: string | null } | null) =>
	p ? { id: p.id, name: p.name, avatar_url: p.avatarUrl } : null;
const blocker = (b: DocStepOut['completeBlockers'][number]) => ({
	kind: b.kind,
	message: b.message,
	issue_id: b.issueId,
	issue_number: b.issueNumber
});
const hold = (h: DocStepOut['holds'][number]) => ({
	issue_id: h.issueId,
	issue_number: h.issueNumber,
	title: h.title,
	kind: h.kind,
	disposition_state: h.dispositionState,
	ticket_state: h.ticketState
});
const cursor = (c: DocStepOut['cursors'][number]) => ({
	user_id: c.userId,
	name: c.name,
	avatar_url: c.avatarUrl,
	initials: c.initials,
	focused_at: c.focusedAt,
	stale: c.stale
});
const consumption = (c: ApiDocument['consumptions'][number]) => ({
	id: c.id,
	part_id: c.partId,
	part_number: c.partNumber,
	part_name: c.partName,
	opal_number: c.opalNumber,
	quantity: num(c.quantity),
	lot_number: c.lotNumber,
	location: c.location,
	usage_type: c.usage,
	step_execution_id: c.stepId,
	step_number: c.stepNumber
});
const attachment = (a: ApiDocument['attachments'][number]) => ({
	id: a.id,
	filename: a.filename,
	mime_type: a.mimeType,
	size_bytes: a.sizeBytes,
	kind: a.kind,
	note: a.note,
	uploaded_by: a.uploadedBy,
	created_at: a.createdAt
});

function step(s: DocStepOut, parentOrder: number | null): DocStep {
	return {
		order: s.id,
		execution_id: s.id,
		number: s.number,
		title: s.title,
		level: s.level,
		is_op: s.isOp,
		parent_order: parentOrder,
		status: s.status,
		instructions: s.instructions,
		callouts: s.callouts,
		role: s.role,
		requires_signoff: s.requiresSignoff,
		is_contingency: s.isContingency,
		estimated_duration_minutes: s.estimatedDurationMinutes,
		images: s.images.map((i) => ({ attachment_id: 0, sha256: i.sha256, caption: i.caption })),
		step_kit: s.stepKit.map((k) => ({
			part_id: k.partId,
			part_name: k.partName,
			part_number: k.partNumber,
			quantity_required: num(k.quantity),
			usage_type: k.usage,
			notes: k.notes
		})),
		data_schema: s.dataSchema,
		data_captured: s.dataCaptured,
		skip_reason: s.skipReason,
		started_at: s.startedAt,
		completed: s.completed,
		signed_off: s.signedOff,
		duration_seconds: s.durationSeconds,
		cursors: s.cursors.map(cursor),
		holds: s.holds.map(hold),
		issue_history: s.issueHistory.map((h) => ({
			issue_id: h.issueId,
			issue_number: h.issueNumber,
			state: h.state,
			disposition_type: h.dispositionType
		})),
		complete_blockers: s.completeBlockers.map(blocker),
		skip_blockers: s.skipBlockers.map(blocker),
		notes: s.notes.map((n) => ({
			id: n.id,
			author: person(n.author),
			created_at: n.createdAt,
			body: n.body,
			attachments: n.attachments.map((a) => ({
				id: a.id,
				filename: a.filename,
				mime_type: a.mimeType,
				size_bytes: a.sizeBytes,
				url: a.url,
				is_image: a.isImage
			}))
		})),
		signoffs: s.signoffs.map((g) => ({
			slot: g.slot,
			label: g.label,
			role: g.role,
			signed_by: person(g.signedBy),
			signed_at: g.signedAt,
			can_sign: g.canSign,
			blockers: g.blockers.map(blocker)
		})),
		attachments: s.attachments.map(attachment),
		consumptions: s.consumptions.map(consumption),
		waiting: s.waiting
	};
}

function op(o: DocOpOut): DocOp {
	return {
		order: o.id,
		number: o.number,
		title: o.title,
		status: o.status,
		instructions: o.instructions,
		callouts: o.callouts,
		role: o.role,
		strict_sequence: o.strictSequence,
		is_contingency: o.isContingency,
		is_ad_hoc: o.isAdHoc,
		redline: o.redline && {
			issue_id: o.redline.issueId,
			issue_number: o.redline.issueNumber,
			title: o.redline.title,
			host_order: o.redline.hostId
		},
		waiting_on_ops: o.waitingOnOps,
		holds: o.holds.map(hold),
		open_ncs: o.openNcs.map((n) => ({ id: n.id, issue_number: n.issueNumber, title: n.title })),
		progress: o.progress,
		step: step(o.step, null),
		steps: o.steps.map((s) => step(s, o.id))
	};
}

const rosterEntry = (r: ApiDocument['roster'][number]) => ({
	user_id: r.userId,
	name: r.name,
	initials: r.initials,
	avatar_url: r.avatarUrl,
	step_order: r.stepId,
	step_number: r.stepNumber,
	focused_at: r.focusedAt,
	stale: r.stale
});
const holdSummary = (h: ApiDocument['holds'][number]) => ({
	issue_id: h.issueId,
	issue_number: h.issueNumber,
	title: h.title,
	disposition_state: h.dispositionState,
	ticket_state: h.ticketState,
	blocks: h.blocks
});

export function adaptDocument(d: ApiDocument): ExecutionDocument {
	const e = d.execution;
	return {
		instance: {
			id: e.id,
			work_order: e.woNumber,
			status: e.status,
			active: e.active,
			priority: e.priority,
			project: { id: e.projectId, code: e.projectCode, name: e.projectName },
			procedure: {
				id: e.procedure.id,
				template_number: e.procedure.templateNumber,
				name: e.procedure.name,
				type: e.procedure.type
			},
			version: {
				id: e.version.id,
				number: e.version.number,
				created_at: e.version.createdAt,
				created_by: e.version.createdBy
			},
			created_at: e.createdAt,
			created_by: e.createdBy,
			started_at: e.startedAt,
			completed_at: e.completedAt,
			scheduled_start_at: e.scheduledStartAt,
			target_completion_at: e.targetCompletionAt,
			last_activity_at: e.lastActivityAt,
			duration_seconds: e.durationSeconds
		},
		progress: d.progress,
		ops: d.ops.map(op),
		contingency_ops: d.contingencyOps.map(op),
		issues: d.issues.map((i) => ({
			id: i.id,
			issue_number: i.issueNumber,
			title: i.title,
			issue_type: i.issueType,
			priority: i.priority,
			status: i.status,
			state: i.state,
			ticket_state: i.ticketState,
			containment: i.containment,
			disposition_type: i.dispositionType,
			is_blocking: i.isBlocking,
			raised_step_number: i.raisedStepNumber,
			created_at: i.createdAt
		})),
		holds: d.holds.map(holdSummary),
		roster: d.roster.map(rosterEntry),
		my_cursor_order: d.myCursorId,
		kit: {
			items: d.kit.items.map((k) => ({
				part_id: k.partId,
				part_number: k.partNumber,
				part_name: k.partName,
				uom: k.uom,
				qty_required: num(k.qtyRequired),
				qty_consumed: num(k.qtyConsumed),
				variance: num(k.variance)
			})),
			unplanned: d.kit.unplanned.map((k) => ({
				part_id: k.partId,
				part_number: k.partNumber,
				part_name: k.partName,
				qty_consumed: num(k.qtyConsumed)
			}))
		},
		consumptions: d.consumptions.map(consumption),
		outputs: d.outputs.map((o) => ({
			part_id: o.partId,
			part_number: o.partNumber,
			part_name: o.partName,
			quantity: num(o.quantity)
		})),
		productions: d.productions.map((p) => ({
			id: p.id,
			part_id: p.partId,
			part_number: p.partNumber,
			part_name: p.partName,
			serial_number: p.serialNumber,
			opal_number: p.opalNumber,
			quantity: num(p.quantity),
			lot_number: p.lotNumber,
			location: p.location,
			status: p.status
		})),
		kit_relevant: d.kitRelevant,
		material_relevant: d.materialRelevant,
		can_finalize: d.canFinalize,
		reference_attachments: d.referenceAttachments.map(attachment),
		attachments: d.attachments.map(attachment),
		data_rows: d.dataRows.map((r) => ({
			step_number: r.stepNumber,
			step_order: r.stepId,
			field: r.field,
			unit: r.unit,
			spec: r.spec ?? null,
			out_of_spec: r.outOfSpec ?? false,
			value: r.value,
			by: r.by,
			at: r.at
		})),
		generated_at: d.generatedAt
	};
}

export function adaptState(s: ApiState): ExecutionState {
	return {
		instance: { id: s.execution.id, status: s.execution.status, progress: s.execution.progress },
		steps: s.steps.map((x) => ({
			order: x.id,
			status: x.status,
			cursors: x.cursors.map(cursor),
			holds: x.holds.map((h) => ({
				issue_id: h.issueId,
				issue_number: h.issueNumber,
				disposition_state: h.dispositionState,
				kind: h.kind
			})),
			attachments: x.attachments,
			consumed: x.consumed,
			notes: x.notes
		})),
		roster: s.roster.map(rosterEntry),
		holds: s.holds.map(holdSummary),
		generated_at: s.generatedAt
	};
}
