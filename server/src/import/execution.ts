/**
 * procedure_instance, step_execution, step_signoff, step_note, step_focus (and the
 * execution links of stock moves, issues and data points).
 *
 * Mapping (no other agent wrote one; this follows the legacy models and the execution schema):
 *
 * - procedure_instance -> execution. Same id. work_order_number -> wo_number (a missing number
 *   gets the next WO number). priority 0/1/2 -> normal/high/urgent. started_by_id -> created_by_id.
 *   The project is the imported project.
 * - step_execution without ad_hoc_issue_id -> step_execution. Same id. step_number is the
 *   snapshot `order`; step_id is the snapshot step id with that order.
 * - step_execution with ad_hoc_issue_id (a redline) -> adhoc_step + step_execution. The adhoc
 *   row takes the same id as the step execution. Level 1 rows hang under the level 0 row
 *   whose step_number is their parent_step_order. host_step_id is the snapshot step with
 *   order ad_hoc_host_order.
 * - Status: the new states are pending | awaiting_signoff | completed | skipped.
 *   in_progress and on_hold become pending (a hold is derived from issues now);
 *   signed_off becomes completed with every slot signed; a completed leaf has slot 0 signed
 *   and is awaiting_signoff while a later slot is open. A missing signature row is written
 *   from signed_off_at / completed_at.
 * - step_signoff -> signoff, same ids. step_note -> step_note, same ids.
 * - procedure_instance.participants (JSON) and step_focus -> execution_participant.
 * - inventory_production with a work order -> execution_output (the plan); the stock move
 *   of a consumption or production gets execution_id and step_execution_id.
 */
import { EXECUTION_PRIORITIES, EXECUTION_STATUSES, type ProcedureSnapshot } from '@opal/shared';
import { eq, inArray } from 'drizzle-orm';
import {
	adhocStep,
	dataPoint,
	execution,
	executionOutput,
	executionParticipant,
	issue,
	procedureVersion,
	signoff,
	stepExecution,
	stepNote,
	stockMove
} from '../db/schema/index.ts';
import { slotLabel } from '../services/procedures/signoffs.ts';
import { effectiveSignoffs } from '../services/procedures/signoffs.ts';
import {
	type ImportCtx,
	type Row,
	derived,
	fail,
	insertRows,
	json,
	keepLegacyRow,
	legacyQty,
	num,
	readTable,
	ref,
	str,
	track,
	ts,
	tsReq,
	warn
} from './context.ts';
import type { InventoryLinks } from './inventory.ts';

type Status = 'pending' | 'awaiting_signoff' | 'completed' | 'skipped';
interface Slot {
	role: string | null;
}

export function importExecutions(c: ImportCtx, links: InventoryLinks): void {
	const instances = readTable(c, 'procedure_instance', ['id', 'procedure_id', 'version_id', 'work_order_number', 'status', 'started_at', 'completed_at', 'started_by_id', 'participants', 'scheduled_start_at', 'target_completion_at', 'priority', 'created_at', 'updated_at']);
	const steps = readTable(c, 'step_execution', ['id', 'instance_id', 'step_number', 'status', 'data_captured', 'started_at', 'first_focused_at', 'completed_at', 'completed_by_id', 'workcenter_id', 'step_number_str', 'level', 'parent_step_order', 'signed_off_at', 'signed_off_by_id', 'ad_hoc_issue_id', 'ad_hoc_host_order', 'title', 'instructions', 'required_data_schema', 'requires_signoff', 'signoffs', 'created_at', 'updated_at']);
	const signs = readTable(c, 'step_signoff', ['id', 'step_execution_id', 'slot', 'label', 'role', 'signed_by_id', 'signed_at', 'created_at']);
	const notes = readTable(c, 'step_note', ['id', 'step_execution_id', 'author_id', 'body', 'created_at']);
	const focus = readTable(c, 'step_focus', ['id', 'instance_id', 'step_execution_id', 'user_id', 'focused_at', 'created_at']);

	// ---- executions
	const usedWo = new Set(instances.map((i) => str(i.work_order_number)).filter((x): x is string => !!x));
	let woMax = Math.max(0, ...[...usedWo].map((w) => Number(/^WO-(\d+)$/.exec(w)?.[1] ?? 0)));
	const execRows = instances.flatMap((r) => {
		const id = Number(r.id);
		if (!c.ids.procedure!.has(Number(r.procedure_id)) || !c.ids.procedure_version!.has(Number(r.version_id))) {
			fail(c, 'procedure_instance', id, 'procedure or version is not imported');
			return [];
		}
		let wo = str(r.work_order_number);
		if (!wo) {
			wo = `WO-${String(++woMax).padStart(5, '0')}`;
			warn(c, `procedure_instance ${id}: no work order number, given ${wo}`);
		}
		const status = (EXECUTION_STATUSES as readonly string[]).includes(String(r.status)) ? (String(r.status) as (typeof EXECUTION_STATUSES)[number]) : 'cut';
		if (status !== r.status) warn(c, `procedure_instance ${id}: status "${String(r.status)}" is not valid, used "cut"`);
		const p = Number(r.priority);
		return [{
			id,
			woNumber: wo,
			projectId: c.projectId,
			procedureId: Number(r.procedure_id),
			versionId: Number(r.version_id),
			status,
			priority: (EXECUTION_PRIORITIES[Math.min(2, Math.max(0, Number.isFinite(p) ? p : 0))] ?? 'normal') as (typeof EXECUTION_PRIORITIES)[number],
			scheduledStartAt: ts(r.scheduled_start_at),
			targetCompletionAt: ts(r.target_completion_at),
			startedAt: ts(r.started_at),
			completedAt: ts(r.completed_at),
			abortReason: null,
			createdById: ref(c, 'user', r.started_by_id, `procedure_instance ${id} started_by_id`),
			createdAt: tsReq(r.created_at),
			updatedAt: tsReq(r.updated_at)
		}];
	});
	track(c, 'execution', insertRows(c, 'procedure_instance', execution, execRows));

	// ---- snapshot facts per version: order -> step id, and each step's sign-off slots
	const versionIds = [...new Set(execRows.map((e) => e.versionId))];
	const versions = new Map<number, { byOrder: Map<number, number>; slots: Map<number, Slot[]>; kids: Set<number> }>();
	for (const v of versionIds.length ? c.d.select().from(procedureVersion).where(inArray(procedureVersion.id, versionIds)).all() : []) {
		const snap = v.content as ProcedureSnapshot;
		versions.set(v.id, {
			byOrder: new Map(snap.steps.map((s) => [s.order, s.id])),
			slots: new Map(snap.steps.map((s) => [s.id, s.signoffs.map((x) => ({ role: x.role }))])),
			kids: new Set(snap.steps.map((s) => s.parentId).filter((x): x is number => x !== null))
		});
	}
	const versionOf = new Map(execRows.map((e) => [e.id, e.versionId]));

	// ---- sign-offs per step execution
	const signsByStep = new Map<number, Row[]>();
	for (const s of signs) signsByStep.set(Number(s.step_execution_id), [...(signsByStep.get(Number(s.step_execution_id)) ?? []), s]);
	let signId = Math.max(0, ...signs.map((s) => Number(s.id)));
	const signRows: Record<string, unknown>[] = [];

	const stepRows: Record<string, unknown>[] = [];
	const adhocRows: Record<string, unknown>[] = [];

	/** Resolves the new status of a step and writes the signature rows it lacks. */
	const resolve = (r: Row, slots: Slot[], hasKids: boolean) => {
		const id = Number(r.id);
		const have = signsByStep.get(id) ?? [];
		const signed = new Set(have.map((s) => Number(s.slot)));
		const legacy = String(r.status);
		const at = ts(r.signed_off_at) ?? ts(r.completed_at) ?? tsReq(r.updated_at);
		const by = ref(c, 'user', r.signed_off_by_id ?? r.completed_by_id, `step_execution ${id} signer`);
		const synth = (slot: number) => {
			signed.add(slot);
			signRows.push({ id: ++signId, stepExecutionId: id, slot, label: slotLabel(slot), role: slots[slot]?.role ?? null, signedById: by, signedAt: at, createdAt: at });
		};
		let status: Status = 'pending';
		if (legacy === 'skipped') status = 'skipped';
		else if (legacy === 'signed_off') {
			for (let i = 0; i < slots.length; i++) if (!signed.has(i)) synth(i);
			status = 'completed';
		} else if (legacy === 'completed') {
			if (hasKids) status = 'completed';
			else {
				if (slots.length > 0 && !signed.has(0)) synth(0);
				status = slots.every((_, i) => signed.has(i)) ? 'completed' : 'awaiting_signoff';
			}
		} else if (legacy === 'awaiting_signoff') {
			status = slots.length === 0 ? 'completed' : slots.every((_, i) => signed.has(i)) ? 'completed' : 'awaiting_signoff';
		}
		return status;
	};

	const base = (r: Row, status: Status) => ({
		id: Number(r.id),
		executionId: Number(r.instance_id),
		status,
		dataCaptured: json<Record<string, unknown>>(r.data_captured),
		skipReason: null,
		startedAt: ts(r.started_at),
		completedAt: ts(r.completed_at) ?? ts(r.signed_off_at),
		completedById: ref(c, 'user', r.completed_by_id ?? r.signed_off_by_id, `step_execution ${Number(r.id)} completed_by_id`),
		workcenterId: ref(c, 'workcenter', r.workcenter_id, `step_execution ${Number(r.id)} workcenter_id`),
		firstFocusedAt: ts(r.first_focused_at),
		createdAt: tsReq(r.created_at),
		updatedAt: tsReq(r.updated_at)
	});

	const live = steps.filter((s) => {
		if (c.ids.execution!.has(Number(s.instance_id))) return true;
		fail(c, 'step_execution', Number(s.id), `execution ${Number(s.instance_id)} is not imported`);
		return false;
	});

	for (const r of live.filter((s) => s.ad_hoc_issue_id == null)) {
		const id = Number(r.id);
		const v = versions.get(versionOf.get(Number(r.instance_id))!);
		const stepId = v?.byOrder.get(Number(r.step_number));
		if (!v || stepId === undefined) {
			fail(c, 'step_execution', id, `the version has no step with order ${Number(r.step_number)}`);
			keepLegacyRow(c, 'step_execution', r, 'no matching snapshot step');
			continue;
		}
		const status = resolve(r, v.slots.get(stepId) ?? [], v.kids.has(stepId));
		stepRows.push({ ...base(r, status), stepId, adhocStepId: null });
	}

	// ---- redlines: level 0 rows first so the sub-steps can name them
	const adhoc = live.filter((s) => s.ad_hoc_issue_id != null);
	const opByNumber = new Map<string, Row>();
	for (const r of adhoc.filter((s) => Number(s.level) === 0)) opByNumber.set(`${Number(r.instance_id)}/${Number(r.step_number)}`, r);
	const adhocKids = new Set(adhoc.filter((s) => Number(s.level) !== 0).map((s) => `${Number(s.instance_id)}/${Number(s.parent_step_order)}`));
	const position = new Map<string, number>();
	for (const r of [...adhoc].sort((a, b) => Number(a.step_number) - Number(b.step_number))) {
		const id = Number(r.id);
		if (!c.ids.issue!.has(Number(r.ad_hoc_issue_id))) {
			fail(c, 'step_execution', id, `redline issue ${Number(r.ad_hoc_issue_id)} is not imported`);
			keepLegacyRow(c, 'step_execution', r, 'redline without an issue');
			continue;
		}
		const isOp = Number(r.level) === 0;
		const parent = isOp ? null : opByNumber.get(`${Number(r.instance_id)}/${Number(r.parent_step_order)}`);
		if (!isOp && !parent) {
			fail(c, 'step_execution', id, 'redline sub-step has no redline OP');
			keepLegacyRow(c, 'step_execution', r, 'redline sub-step without its OP');
			continue;
		}
		const hasKids = adhocKids.has(`${Number(r.instance_id)}/${Number(r.step_number)}`);
		const explicit = json<{ role?: string | null }[]>(r.signoffs);
		const role = null;
		const requires = Number(r.requires_signoff) !== 0;
		const stored: Slot[] = Array.isArray(explicit)
			? explicit.map((x) => ({ role: x.role ?? null }))
			: hasKids ? (requires ? [{ role }] : []) : requires ? [{ role }, { role: null }] : [{ role }];
		const slots = effectiveSignoffs(stored, hasKids).map((x) => ({ role: x.role }));
		const posKey = `${Number(r.instance_id)}/${parent ? Number(parent.id) : 'op'}/${isOp ? Number(r.ad_hoc_host_order) : ''}`;
		const pos = position.get(posKey) ?? 0;
		position.set(posKey, pos + 1);
		const v = versions.get(versionOf.get(Number(r.instance_id))!);
		adhocRows.push({
			id,
			executionId: Number(r.instance_id),
			issueId: Number(r.ad_hoc_issue_id),
			parentId: parent ? Number(parent.id) : null,
			hostStepId: v?.byOrder.get(Number(r.ad_hoc_host_order)) ?? null,
			position: pos,
			number: String(r.step_number_str),
			title: String(r.title ?? ''),
			instructions: str(r.instructions),
			dataSchema: json(r.required_data_schema),
			signoffs: slots,
			createdById: null,
			createdAt: tsReq(r.created_at)
		});
		stepRows.push({ ...base(r, resolve(r, slots, hasKids)), stepId: null, adhocStepId: id });
	}
	derived(c, 'adhoc_step', insertRows(c, 'step_execution', adhocStep, adhocRows, { count: false }).length);

	const written = new Set(insertRows(c, 'step_execution', stepExecution, stepRows));
	track(c, 'step_execution', written);

	// ---- signatures, notes
	const signKept = signs
		.filter((s) => written.has(Number(s.step_execution_id)))
		.map((s) => ({ id: Number(s.id), stepExecutionId: Number(s.step_execution_id), slot: Number(s.slot), label: String(s.label), role: str(s.role), signedById: ref(c, 'user', s.signed_by_id, `step_signoff ${Number(s.id)} signed_by_id`), signedAt: tsReq(s.signed_at), createdAt: tsReq(s.created_at) }));
	insertRows(c, 'step_signoff', signoff, signKept);
	derived(c, 'signoff_written_from_status', insertRows(c, 'step_signoff', signoff, signRows.filter((s) => written.has(s.stepExecutionId as number)), { count: false }).length);
	insertRows(c, 'step_note', stepNote, notes
		.filter((n) => written.has(Number(n.step_execution_id)))
		.map((n) => ({ id: Number(n.id), stepExecutionId: Number(n.step_execution_id), authorId: ref(c, 'user', n.author_id, `step_note ${Number(n.id)} author_id`), body: String(n.body), createdAt: tsReq(n.created_at) })));
	track(c, 'step_note', notes.map((n) => Number(n.id)));

	// ---- participants: who joined (participants JSON) and where each person works (step_focus)
	const people = new Map<string, { executionId: number; userId: number; joinedAt: string | null; focusStepId: number | null; focusedAt: string | null; lastActiveAt: string }>();
	for (const i of instances) {
		if (!c.ids.execution!.has(Number(i.id))) continue;
		const list = json<{ user_id?: number; joined_at?: string; last_active?: string }[]>(i.participants);
		for (const p of Array.isArray(list) ? list : []) {
			if (!p.user_id || !c.ids.user!.has(Number(p.user_id))) continue;
			const joined = p.joined_at ? ts(String(p.joined_at).replace('+00:00', 'Z')) : tsReq(i.created_at);
			people.set(`${Number(i.id)}/${p.user_id}`, { executionId: Number(i.id), userId: Number(p.user_id), joinedAt: joined, focusStepId: null, focusedAt: null, lastActiveAt: (p.last_active ? ts(String(p.last_active).replace('+00:00', 'Z')) : null) ?? joined ?? tsReq(i.created_at) });
		}
	}
	for (const f of focus) {
		const e = Number(f.instance_id);
		const u = Number(f.user_id);
		if (!c.ids.execution!.has(e) || !c.ids.user!.has(u)) continue;
		const at = tsReq(f.focused_at);
		const key = `${e}/${u}`;
		const have = people.get(key);
		const step = written.has(Number(f.step_execution_id)) ? Number(f.step_execution_id) : null;
		people.set(key, { executionId: e, userId: u, joinedAt: have?.joinedAt ?? null, focusStepId: step, focusedAt: at, lastActiveAt: have && have.lastActiveAt > at ? have.lastActiveAt : at });
	}
	const peopleRows = [...people.values()].map((p, i) => ({ id: i + 1, ...p }));
	insertRows(c, 'step_focus', executionParticipant, peopleRows, { count: false });
	c.report.tables.step_focus!.imported = focus.filter((f) => people.get(`${Number(f.instance_id)}/${Number(f.user_id)}`)?.focusStepId === Number(f.step_execution_id)).length;
	derived(c, 'execution_participant', peopleRows.length);

	// ---- planned and booked production
	const outputs = (c.src.query('SELECT id, inventory_record_id, quantity, procedure_instance_id, created_at FROM inventory_production WHERE procedure_instance_id IS NOT NULL ORDER BY id').all() as Row[])
		.filter((p) => c.ids.execution!.has(Number(p.procedure_instance_id)) && c.ids.stock_record!.has(Number(p.inventory_record_id)) && (legacyQty(p.quantity) ?? 0) > 0)
		.map((p) => ({ id: Number(p.id), executionId: Number(p.procedure_instance_id), stockId: Number(p.inventory_record_id), quantity: legacyQty(p.quantity)!, createdAt: tsReq(p.created_at) }));
	derived(c, 'execution_output', insertRows(c, 'inventory_production', executionOutput, outputs, { count: false }).length);

	// ---- links from stock moves, issues and data points
	const consumed = new Map((c.src.query('SELECT id, procedure_instance_id, step_execution_id FROM inventory_consumption').all() as Row[]).map((r) => [Number(r.id), r]));
	for (const [legacyId, moveId] of links.consumptionMove) {
		const r = consumed.get(legacyId);
		const executionId = r?.procedure_instance_id != null && c.ids.execution!.has(Number(r.procedure_instance_id)) ? Number(r.procedure_instance_id) : null;
		const stepId = r?.step_execution_id != null && written.has(Number(r.step_execution_id)) ? Number(r.step_execution_id) : null;
		if (r?.procedure_instance_id != null && executionId === null) warn(c, `inventory_consumption ${legacyId}: work order ${Number(r.procedure_instance_id)} is not imported, link cleared`);
		if (executionId !== null || stepId !== null) c.d.update(stockMove).set({ executionId, stepExecutionId: stepId }).where(eq(stockMove.id, moveId)).run();
	}
	const produced = new Map((c.src.query('SELECT id, procedure_instance_id FROM inventory_production').all() as Row[]).map((r) => [Number(r.id), r]));
	for (const [legacyId, moveId] of links.productionMove) {
		const e = produced.get(legacyId)?.procedure_instance_id;
		if (e != null && c.ids.execution!.has(Number(e))) c.d.update(stockMove).set({ executionId: Number(e) }).where(eq(stockMove.id, moveId)).run();
	}
	for (const r of c.d.select().from(issue).all()) {
		const patch: Partial<typeof issue.$inferInsert> = {};
		if (r.executionId !== null && !c.ids.execution!.has(r.executionId)) patch.executionId = null;
		if (r.containmentStepId !== null && !written.has(r.containmentStepId)) patch.containmentStepId = null;
		if (r.raisedStepId !== null && !written.has(r.raisedStepId)) patch.raisedStepId = null;
		if (Object.keys(patch).length) {
			warn(c, `issue ${r.id}: reference to a work order or step that is not imported, cleared`);
			c.d.update(issue).set(patch).where(eq(issue.id, r.id)).run();
		}
	}
	for (const p of c.d.select({ id: dataPoint.id, s: dataPoint.stepExecutionId }).from(dataPoint).all()) {
		if (p.s !== null && !written.has(p.s)) {
			warn(c, `data_point ${p.id}: step execution ${p.s} is not imported, link cleared`);
			c.d.update(dataPoint).set({ stepExecutionId: null }).where(eq(dataPoint.id, p.id)).run();
		}
	}
	void num;
}
