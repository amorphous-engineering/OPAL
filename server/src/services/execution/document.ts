/**
 * The execution document view model. One builder assembles everything the execution page
 * renders: the OP and step hierarchy (redline OPs before their host), the gates the server
 * enforces, holds, waits, cursors, notes, evidence, kit and consumption. The client decides
 * nothing: a control is inert exactly when the step's `completeBlockers` / `skipBlockers` are
 * non-empty, because those lists are the same fold the commitment operations refuse on.
 */
import {
	type DocOpOut,
	type DocStepOut,
	type ExecutionDocument,
	type ExecutionState,
	type ExecHold,
	now,
	specResult,
	specText,
	unitSymbol
} from '@opal/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { actorUserId, type Ctx } from '../../context.ts';
import { laborRows } from './labor.ts';
import type { Db } from '../../db/client.ts';
import { attachment, blob, issue, part, project, stepNote, user } from '../../db/schema/index.ts';
import { dispState, isBlocking, ticketState } from '../issues/state.ts';
import { roleNamesOf, holdsSlotRole } from '../org/roles.ts';
import { type HoldingIssue } from '../issues/holds.ts';
import { type Blocker, completeBlockers, skipBlockers, slotGate } from './gates.ts';
import { type HoldState, blockersForBound, holdState } from './holds.ts';
import { consumptionRows, productionRows, reconcile, unbooked } from './material.ts';
import { type Model, type Row, isActive, isTerminal, loadModel, progress } from './model.ts';
import { claimsFor, cursorOf, roster, touch } from './presence.ts';
import { initials, personRefs, signoffRecords } from './present.ts';

type Att = {
	id: number;
	filename: string;
	mimeType: string;
	sizeBytes: number;
	kind: string | null;
	note: string | null;
	uploadedBy: string | null;
	createdAt: string;
	ownerId: number;
};

function attachments(db: Db, ownerType: string, ownerIds: number[], kind?: string): Att[] {
	if (!ownerIds.length) return [];
	return db
		.select({ a: attachment, b: blob, u: user.name })
		.from(attachment)
		.innerJoin(blob, eq(blob.sha256, attachment.blobSha256))
		.leftJoin(user, eq(user.id, attachment.uploadedById))
		.where(and(eq(attachment.ownerType, ownerType), inArray(attachment.ownerId, ownerIds), kind ? eq(attachment.kind, kind as never) : undefined))
		.orderBy(asc(attachment.createdAt), asc(attachment.id))
		.all()
		.map(({ a, b, u }) => ({
			id: a.id,
			filename: a.filename,
			mimeType: b.mimeType,
			sizeBytes: b.sizeBytes,
			kind: a.kind,
			note: a.note,
			uploadedBy: u,
			createdAt: a.createdAt,
			ownerId: a.ownerId
		}));
}

const attOut = ({ ownerId: _o, ...a }: Att) => a;

/** One-line rendering of a captured value (data table, report). */
export function captureDisplay(v: unknown): string {
	if (typeof v === 'boolean') return v ? 'YES' : 'NO';
	if (v === null || v === undefined || v === '') return '—';
	if (Array.isArray(v)) return v.length ? `${v.length} ${v.length === 1 ? 'image' : 'images'}` : '—';
	return String(v);
}

type FieldDef = NonNullable<Row['dataSchema']>['fields'][number];

/** Unit symbol, spec text and out-of-spec flag of one captured value (document and report). */
export function readingOf(f: FieldDef | undefined, value: unknown) {
	return {
		unit: f?.unit ? unitSymbol(f.unit) : null,
		spec: f?.spec ? specText(f.spec, f.unit) : null,
		outOfSpec: !!f?.spec && specResult(f.spec, value) === 'out_of_spec'
	};
}

const holdEntry = (i: HoldingIssue, kind: 'raised' | 'bound'): ExecHold => ({
	issueId: i.id,
	issueNumber: i.issueNumber,
	title: i.title,
	kind,
	dispositionState: 'undispositioned',
	ticketState: i.ticketState
});

/** Holds shown on a row: bound first, then raised (step and, for an OP, op containment). */
function holdsOf(st: HoldState, row: Row): ExecHold[] {
	const raised = new Map<number, HoldingIssue>();
	for (const i of st.completeBlocked.get(row.id) ?? []) raised.set(i.id, i);
	for (const i of st.opCompleteBlocked.get(row.id) ?? []) raised.set(i.id, i);
	return [...blockersForBound(st, row).map((i) => holdEntry(i, 'bound')), ...[...raised.values()].map((i) => holdEntry(i, 'raised'))];
}

export function summarizeHolds(m: Model, st: HoldState) {
	const out = new Map<number, { issueId: number; issueNumber: string; title: string; dispositionState: string; ticketState: string; blocks: string[] }>();
	const add = (rowId: number | null, i: HoldingIssue) => {
		const e = out.get(i.id) ?? {
			issueId: i.id,
			issueNumber: i.issueNumber,
			title: i.title,
			dispositionState: 'undispositioned',
			ticketState: i.ticketState,
			blocks: [] as string[]
		};
		out.set(i.id, e);
		const num = rowId === null ? null : m.byId.get(rowId)?.number;
		if (num && !e.blocks.includes(num)) e.blocks.push(num);
	};
	for (const [id, list] of [...st.startBlocked, ...st.completeBlocked, ...st.opCompleteBlocked]) for (const i of list) add(id, i);
	for (const i of st.woBlocked) add(null, i);
	return [...out.values()].sort((a, b) => a.issueNumber.localeCompare(b.issueNumber));
}

export function buildDocument(ctx: Ctx, executionId: number): ExecutionDocument {
	const db = ctx.db;
	const viewer = actorUserId(ctx.actor);
	const m = loadModel(db, executionId);
	const exec = m.exec;
	const st = holdState(db, m);
	const active = isActive(exec);

	const claims = claimsFor(db, m);
	const rosterRows = roster(db, m);
	const stepIds = m.rows.map((r) => r.id);
	const recs = signoffRecords(db, stepIds);
	const notes = stepIds.length
		? db.select().from(stepNote).where(inArray(stepNote.stepExecutionId, stepIds)).orderBy(asc(stepNote.createdAt), asc(stepNote.id)).all()
		: [];
	const noteAtts = attachments(db, 'step_note', notes.map((n) => n.id));
	const stepAtts = attachments(db, 'step_execution', stepIds);
	const woAtts = attachments(db, 'execution', [exec.id]);
	const refAtts = attachments(db, 'procedure', [exec.procedureId], 'reference');
	const consumptions = consumptionRows(db, m);

	const issues = db.select().from(issue).where(eq(issue.executionId, exec.id)).all();
	const rank: Record<string, number> = { undispositioned: 0, open: 1, dispositioned: 2, closed: 3 };
	issues.sort((a, b) => Number(isBlocking(b)) - Number(isBlocking(a)) || (rank[dispState(a)] ?? 4) - (rank[dispState(b)] ?? 4) || b.id - a.id);

	const people = personRefs(db, [
		...claims.map((c) => c.userId),
		...stepIds.flatMap((id) => (recs.get(id) ?? []).map((s) => s.signedById)).filter((x): x is number => x !== null),
		...notes.map((n) => n.authorId).filter((x): x is number => x !== null),
		...m.rows.map((r) => r.se.completedById).filter((x): x is number => x !== null),
		...(exec.createdById === null ? [] : [exec.createdById]),
		...(m.version.createdById === null ? [] : [m.version.createdById])
	]);
	const nameOf = (id: number | null) => (id === null ? null : (people.get(id)?.name ?? null));
	const viewerRoles = viewer === null ? null : roleNamesOf(db, viewer);

	const cursorsOf = new Map<number, ReturnType<typeof cursorOf>[]>();
	let myCursorId: number | null = null;
	for (const c of claims) {
		const p = people.get(c.userId);
		cursorsOf.set(c.stepId, [...(cursorsOf.get(c.stepId) ?? []), cursorOf(c, p?.name ?? null, p?.avatarUrl ?? null)]);
		if (viewer !== null && c.userId === viewer) myCursorId = c.stepId;
	}

	const partIds = [...new Set(m.snapshot.steps.flatMap((s) => s.kit.map((k) => k.partId)))];
	const parts = new Map(partIds.length ? db.select().from(part).where(inArray(part.id, partIds)).all().map((p) => [p.id, p]) : []);

	const consBy = new Map<number, typeof consumptions>();
	for (const c of consumptions) if (c.stepId !== null) consBy.set(c.stepId, [...(consBy.get(c.stepId) ?? []), c]);

	const buildStep = (row: Row, isOp: boolean): DocStepOut => {
		const complete = completeBlockers(m, st, row, {
			data: row.se.dataCaptured,
			hasNote: notes.some((n) => n.stepExecutionId === row.id),
			hasNc: issues.some((i) => i.raisedStepId === row.id && i.issueType === 'non_conformance')
		});
		const skip = skipBlockers(m, st, row);
		const mine = new Map((recs.get(row.id) ?? []).map((r) => [r.slot, r]));
		const signedSet = new Set(mine.keys());
		const signoffs = row.signoffs.map((d, n) => {
			const rec = mine.get(n);
			const roleOk = viewerRoles === null ? true : holdsSlotRole(viewerRoles, d.role);
			const gate = slotGate(m, st, row, n, signedSet, complete, roleOk);
			return {
				slot: n,
				label: rec?.label ?? d.label,
				role: rec ? rec.role : d.role,
				signedBy: rec?.signedById != null ? (people.get(rec.signedById) ?? null) : null,
				signedAt: rec?.signedAt ?? null,
				canSign: gate.canSign,
				blockers: gate.blockers
			};
		});
		const requiresSignoff = row.hasChildren ? row.signoffs.length > 0 : row.signoffs.length > 1;
		const se = row.se;
		const skipped = se.status === 'skipped';
		const finished = isTerminal(se.status);
		const lastSlot = mine.size ? Math.max(...mine.keys()) : -1;
		const lastRec = lastSlot > 0 && se.status === 'completed' ? mine.get(lastSlot) : undefined;
		const completerName = nameOf(se.completedById);
		return {
			id: row.id,
			templateStepId: row.templateStepId,
			number: row.number,
			title: row.title,
			level: row.level,
			isOp,
			parentId: row.parentId,
			status: se.status,
			instructions: row.instructions,
			callouts: row.callouts,
			role: signoffs.length ? (row.signoffs[0]!.role ?? null) : null,
			requiresSignoff,
			isContingency: row.isContingency,
			estimatedDurationMinutes: row.estimatedDurationMinutes,
			images: row.images,
			stepKit: row.kit.map((k) => ({
				partId: k.partId,
				partNumber: parts.get(k.partId)?.internalPn ?? '',
				partName: parts.get(k.partId)?.name ?? '',
				quantity: k.quantity,
				usage: k.usage,
				notes: k.notes
			})),
			dataSchema: row.dataSchema,
			dataCaptured: skipped ? null : (se.dataCaptured ?? null),
			skipReason: skipped ? se.skipReason : null,
			startedAt: se.startedAt,
			completed: finished ? { by: completerName, initials: initials(completerName), at: se.completedAt } : null,
			signedOff: lastRec ? { by: nameOf(lastRec.signedById), at: lastRec.signedAt } : null,
			durationSeconds: se.startedAt && se.completedAt ? Math.round((Date.parse(se.completedAt) - Date.parse(se.startedAt)) / 1000) : null,
			cursors: cursorsOf.get(row.id) ?? [],
			holds: holdsOf(st, row),
			issueHistory: issues
				.filter((i) => i.raisedStepId === row.id && dispState(i) !== 'undispositioned')
				.map((i) => ({
					issueId: i.id,
					issueNumber: i.issueNumber,
					state: dispState(i),
					ticketState: ticketState(i),
					dispositionType: i.dispositionType
				})),
			completeBlockers: complete as Blocker[],
			skipBlockers: skip as Blocker[],
			notes: notes
				.filter((n) => n.stepExecutionId === row.id)
				.map((n) => ({
					id: n.id,
					author: n.authorId === null ? null : (people.get(n.authorId) ?? null),
					createdAt: n.createdAt,
					body: n.body,
					attachments: noteAtts
						.filter((a) => a.ownerId === n.id)
						.map((a) => ({
							id: a.id,
							filename: a.filename,
							mimeType: a.mimeType,
							sizeBytes: a.sizeBytes,
							url: `/api/attachments/${a.id}/download`,
							isImage: a.mimeType.startsWith('image/')
						}))
				})),
			signoffs,
			attachments: stepAtts.filter((a) => a.ownerId === row.id).map(attOut),
			consumptions: consBy.get(row.id) ?? [],
			waiting: null
		};
	};

	const buildOp = (op: Row): DocOpOut => {
		const kids = m.children.get(op.id) ?? [];
		const opStep = buildStep(op, true);
		const steps = kids.map((k) => buildStep(k, false));
		const waitingOps = op.dependsOn.map((d) => m.byId.get(d)).filter((r): r is Row => !!r && !isTerminal(r.se.status)).map((r) => r.number);
		const depText = waitingOps.length ? `WAITING ON OP ${waitingOps.join(', ')}` : null;
		for (const s of steps) {
			s.waiting = depText;
			if (depText === null && op.strictSequence && s.status === 'pending' && !op.redline) {
				const unmet = steps.filter((p) => p.id !== s.id && steps.indexOf(p) < steps.indexOf(s) && !isTerminal(p.status)).map((p) => p.number);
				if (unmet.length) s.waiting = `WAITING ON ${unmet[0]}${unmet.length > 1 ? ` +${unmet.length - 1}` : ''}`;
			}
		}
		opStep.waiting = depText;
		const seen = new Set<number>();
		const holds: ExecHold[] = [];
		for (const r of [opStep, ...steps]) {
			for (const h of r.holds) {
				if (h.dispositionState === 'undispositioned' && !seen.has(h.issueId)) {
					seen.add(h.issueId);
					holds.push(h);
				}
			}
		}
		const leaf = steps.length ? steps : [opStep];
		const rowIds = new Set([op.id, ...kids.map((k) => k.id)]);
		const openNcs = op.redline
			? []
			: issues
					.filter((i) => i.issueType === 'non_conformance' && i.raisedStepId !== null && rowIds.has(i.raisedStepId) && i.status === 'open')
					.map((i) => ({ id: i.id, issueNumber: i.issueNumber, title: i.title }));
		let redline: DocOpOut['redline'] = null;
		if (op.redline) {
			const ri = issues.find((i) => i.id === op.redline!.issueId) ?? db.select().from(issue).where(eq(issue.id, op.redline!.issueId)).get();
			redline = { issueId: op.redline.issueId, issueNumber: ri?.issueNumber ?? null, title: ri?.title ?? null, hostId: op.redline.hostId };
		}
		return {
			id: op.id,
			number: op.number,
			title: opStep.title,
			status: opStep.status,
			instructions: opStep.instructions,
			callouts: op.callouts,
			role: opStep.role,
			signoffs: opStep.signoffs,
			strictSequence: op.strictSequence,
			isContingency: op.isContingency,
			isAdHoc: op.adhoc !== null,
			redline,
			waitingOnOps: waitingOps,
			holds,
			openNcs,
			progress: { done: leaf.filter((s) => isTerminal(s.status)).length, total: leaf.length },
			step: opStep,
			steps
		};
	};

	const allOps = m.rows.filter((r) => r.level === 0).map(buildOp);
	const ops = allOps.filter((o) => !o.isContingency);
	const contingencyOps = allOps.filter((o) => o.isContingency);

	const rec = reconcile(db, m);
	const productions = productionRows(db, m);
	const outputParts = m.snapshot.outputs.length
		? new Map(db.select().from(part).where(inArray(part.id, m.snapshot.outputs.map((o) => o.partId))).all().map((p) => [p.id, p]))
		: new Map<number, typeof part.$inferSelect>();
	const kitRelevant = m.snapshot.kit.length > 0 || consumptions.length > 0 || m.snapshot.steps.some((s) => s.kit.length > 0);

	const dataRows = m.rows.flatMap((r) => {
		if (!r.se.dataCaptured || r.se.status === 'skipped') return [];
		const fields = new Map((r.dataSchema?.fields ?? []).map((f) => [f.name, f]));
		return Object.entries(r.se.dataCaptured).map(([name, value]) => ({
			stepNumber: r.number,
			stepId: r.id,
			field: fields.get(name)?.label || name,
			...readingOf(fields.get(name), value),
			value: captureDisplay(value),
			by: nameOf(r.se.completedById),
			at: r.se.completedAt ?? r.se.updatedAt
		}));
	});

	const proj = db.select().from(project).where(eq(project.id, exec.projectId)).get()!;
	const activity = [exec.updatedAt, ...m.rows.map((r) => r.se.updatedAt)].sort();
	const dur = exec.startedAt && exec.completedAt ? Math.round((Date.parse(exec.completedAt) - Date.parse(exec.startedAt)) / 1000) : null;

	return {
		execution: {
			id: exec.id,
			woNumber: exec.woNumber,
			status: exec.status,
			active,
			priority: exec.priority,
			projectId: exec.projectId,
			projectCode: proj.code,
			projectName: proj.name,
			procedure: {
				id: exec.procedureId,
				templateNumber: m.snapshot.procedure.templateNumber,
				name: m.snapshot.procedure.name,
				type: m.snapshot.procedure.procedureType
			},
			version: { id: m.version.id, number: m.version.versionNumber, createdAt: m.version.createdAt, createdBy: nameOf(m.version.createdById) },
			createdAt: exec.createdAt,
			createdBy: nameOf(exec.createdById),
			startedAt: exec.startedAt,
			completedAt: exec.completedAt,
			scheduledStartAt: exec.scheduledStartAt,
			targetCompletionAt: exec.targetCompletionAt,
			lastActivityAt: activity[activity.length - 1] ?? null,
			durationSeconds: dur
		},
		progress: progress(m),
		ops,
		contingencyOps,
		issues: issues.map((i) => ({
			id: i.id,
			issueNumber: i.issueNumber,
			title: i.title,
			issueType: i.issueType,
			priority: i.priority,
			status: i.status,
			state: dispState(i),
			ticketState: ticketState(i),
			containment: i.containment,
			dispositionType: i.dispositionType,
			isBlocking: isBlocking(i),
			raisedStepNumber: i.raisedStepId === null ? null : (m.byId.get(i.raisedStepId)?.number ?? null),
			createdAt: i.createdAt
		})),
		holds: summarizeHolds(m, st),
		roster: rosterRows,
		myCursorId,
		kit: { items: rec.kitItems, unplanned: rec.unplanned },
		consumptions,
		outputs: m.snapshot.outputs.map((o) => ({
			partId: o.partId,
			partNumber: outputParts.get(o.partId)?.internalPn ?? '',
			partName: outputParts.get(o.partId)?.name ?? '',
			quantity: o.quantity
		})),
		productions,
		kitRelevant,
		materialRelevant: kitRelevant || productions.length > 0 || m.snapshot.outputs.length > 0,
		canFinalize: exec.status === 'completed' && unbooked(db, exec.id).length > 0,
		referenceAttachments: refAtts.map(attOut),
		attachments: woAtts.map(attOut),
		dataRows,
		labor: laborRows(db, m),
		generatedAt: now()
	};
}

/** The light poll. Also the presence heartbeat of the caller. */
export function buildState(ctx: Ctx, executionId: number): ExecutionState {
	const db = ctx.db;
	touch(db, executionId, actorUserId(ctx.actor));
	const m = loadModel(db, executionId);
	const st = holdState(db, m);
	const claims = claimsFor(db, m);
	const people = personRefs(db, claims.map((c) => c.userId));
	const stepIds = m.rows.map((r) => r.id);
	const noteCount = new Map<number, number>();
	for (const n of stepIds.length ? db.select({ s: stepNote.stepExecutionId }).from(stepNote).where(inArray(stepNote.stepExecutionId, stepIds)).all() : []) {
		noteCount.set(n.s, (noteCount.get(n.s) ?? 0) + 1);
	}
	const attCount = new Map<number, number>();
	for (const a of attachments(db, 'step_execution', stepIds)) attCount.set(a.ownerId, (attCount.get(a.ownerId) ?? 0) + 1);
	const consCount = new Map<number, number>();
	for (const c of consumptionRows(db, m)) if (c.stepId !== null) consCount.set(c.stepId, (consCount.get(c.stepId) ?? 0) + 1);
	return {
		execution: { id: m.exec.id, status: m.exec.status, progress: progress(m) },
		steps: m.rows.map((r) => ({
			id: r.id,
			number: r.number,
			title: r.title,
			status: r.se.status,
			cursors: claims
				.filter((c) => c.stepId === r.id)
				.map((c) => cursorOf(c, people.get(c.userId)?.name ?? null, people.get(c.userId)?.avatarUrl ?? null)),
			holds: holdsOf(st, r),
			attachments: attCount.get(r.id) ?? 0,
			consumed: consCount.get(r.id) ?? 0,
			notes: noteCount.get(r.id) ?? 0
		})),
		roster: roster(db, m),
		holds: summarizeHolds(m, st),
		labor: laborRows(db, m),
		generatedAt: now()
	};
}

