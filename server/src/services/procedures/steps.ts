/** Writing the step tree: add, change, delete, duplicate, move, reorder, op dependencies. */
import {
	type ProcedureStep,
	type zStepAdd,
	type zStepUpdate,
	notFound,
	OpalError
} from '@opal/shared';
import { eq } from 'drizzle-orm';
import type { z } from 'zod';
import type { Ctx } from '../../context.ts';
import type { Db } from '../../db/client.ts';
import {
	attachment,
	kitItem,
	procedureStep,
	stepDependency,
	stepImage,
	workcenter
} from '../../db/schema/index.ts';
import { insert, remove, update } from '../../write.ts';
import { detach } from '../platform/attachments.ts';
import {
	type StepRow,
	dependencyMap,
	presentDraft,
	presentStep,
	procedureRow,
	stepRow,
	stepRows
} from './draft.ts';
import {
	type Placement,
	changedPlacements,
	childrenMap,
	layoutAll,
	normalize,
	place,
	siblingsOf,
	type TreeNode
} from './tree.ts';
import { writeSignoffs } from './signoffs.ts';

export const invalid = (code: string, message: string, fields?: Record<string, string>) =>
	new OpalError(422, code, message, fields);

type AddInput = z.output<typeof zStepAdd>;
type UpdateInput = z.output<typeof zStepUpdate>;

/** Callouts the server keeps: trimmed text, empty boxes dropped. Order is kept. */
export function normalizeCallouts(value: { kind: 'caution' | 'info'; text: string }[] | null | undefined) {
	return (value ?? [])
		.map((c) => ({ kind: c.kind, text: c.text.trim() }))
		.filter((c) => c.text);
}

/** A data schema with no fields is no schema. */
export function normalizeSchema<T extends { fields: unknown[] }>(value: T | null | undefined): T | null {
	return value && value.fields.length ? value : null;
}

export function checkWorkcenter(db: Db, id: number | null | undefined): void {
	if (id == null) return;
	if (!db.select({ id: workcenter.id }).from(workcenter).where(eq(workcenter.id, id)).get()) {
		throw notFound('Workcenter');
	}
}

function applyPlacements(ctx: Ctx, patches: Placement[], skip?: number) {
	for (const p of patches) {
		if (p.id === skip) continue;
		const have = ctx.db.select().from(procedureStep).where(eq(procedureStep.id, p.id)).get();
		if (have && have.parentStepId === p.parentStepId && have.isContingency === p.isContingency && have.position === p.position) {
			continue;
		}
		update(ctx, procedureStep, p.id, {
			parentStepId: p.parentStepId,
			isContingency: p.isContingency,
			position: p.position
		});
	}
}

const asNodes = (rows: StepRow[]): TreeNode[] =>
	rows.map((r) => ({ id: r.id, parentStepId: r.parentStepId, isContingency: r.isContingency, position: r.position }));

/** Close up positions after steps left the tree. */
function renormalize(ctx: Ctx, procedureId: number) {
	applyPlacements(ctx, normalize(asNodes(stepRows(ctx.db, procedureId))));
}

// ------------------------------------------------------------------- add

export function addStep(ctx: Ctx, input: AddInput): ProcedureStep {
	procedureRow(ctx.db, input.id);
	const rows = stepRows(ctx.db, input.id);
	const byId = new Map(rows.map((r) => [r.id, r]));

	let parentId: number | null = null;
	if (input.parentId !== undefined) {
		const parent = byId.get(input.parentId);
		if (!parent) throw notFound('Parent step');
		if (parent.parentStepId !== null) throw invalid('nesting_too_deep', 'Sub-steps cannot hold sub-steps');
		parentId = parent.id;
	}
	let after: StepRow | undefined;
	if (input.afterStepId !== undefined) {
		after = byId.get(input.afterStepId);
		if (!after) throw notFound('Step to insert after');
	}
	checkWorkcenter(ctx.db, input.workcenterId);

	// Where the new step lands: its parent, its group, its index among the siblings.
	let isContingency = parentId === null ? input.isContingency : false;
	let index = Number.MAX_SAFE_INTEGER;
	if (after) {
		if (after.parentStepId !== null) {
			// After a sub-step: same OP, next position.
			parentId = after.parentStepId;
			const sibs = siblingsOf(asNodes(rows), parentId, false);
			index = sibs.findIndex((s) => s.id === after.id) + 1;
		} else if (parentId === after.id) {
			index = 0; // after an OP, inside it: its first sub-step
		} else {
			parentId = null;
			isContingency = after.isContingency;
			const sibs = siblingsOf(asNodes(rows), null, isContingency);
			index = sibs.findIndex((s) => s.id === after.id) + 1;
		}
	}
	if (parentId !== null) isContingency = false;

	const NEW = 0;
	const patches = place(
		[...asNodes(rows), { id: NEW, parentStepId: null, isContingency: false, position: 0 }],
		NEW,
		parentId,
		index,
		isContingency
	);
	const mine = patches.find((p) => p.id === NEW)!;
	const signoffs = writeSignoffs(ctx.db, null, false, input) ?? null;
	const row = insert(ctx, procedureStep, {
		procedureId: input.id,
		parentStepId: mine.parentStepId,
		isContingency: mine.isContingency,
		position: mine.position,
		title: input.title,
		instructions: input.instructions ?? null,
		dataSchema: normalizeSchema(input.dataSchema),
		signoffs,
		estimatedDurationMinutes: input.estimatedDurationMinutes ?? null,
		callouts: normalizeCallouts(input.callouts),
		strictSequence: parentId === null ? (input.strictSequence ?? false) : false,
		workcenterId: input.workcenterId ?? null
	});
	applyPlacements(ctx, patches, NEW);
	return presentStep(ctx, input.id, row.id);
}

// ------------------------------------------------------------------- update

export function updateStep(ctx: Ctx, input: UpdateInput): ProcedureStep {
	procedureRow(ctx.db, input.id);
	const step = stepRow(ctx.db, input.id, input.stepId);
	const rows = stepRows(ctx.db, input.id);
	const hasChildren = rows.some((r) => r.parentStepId === step.id);
	const patch: Partial<typeof procedureStep.$inferInsert> = {};

	if (input.title !== undefined) patch.title = input.title;
	if (input.instructions !== undefined) patch.instructions = input.instructions;
	if (input.dataSchema !== undefined) patch.dataSchema = normalizeSchema(input.dataSchema);
	if (input.estimatedDurationMinutes !== undefined) patch.estimatedDurationMinutes = input.estimatedDurationMinutes;
	if (input.workcenterId !== undefined) {
		checkWorkcenter(ctx.db, input.workcenterId);
		patch.workcenterId = input.workcenterId;
	}
	if (input.callouts !== undefined) patch.callouts = normalizeCallouts(input.callouts);
	if (input.strictSequence !== undefined) patch.strictSequence = input.strictSequence;
	const signoffs = writeSignoffs(ctx.db, step.signoffs, hasChildren, input);
	if (signoffs !== undefined) patch.signoffs = signoffs;

	let regroup = false;
	if (input.isContingency !== undefined && input.isContingency !== step.isContingency) {
		if (step.parentStepId !== null) {
			// A sub-step reports its OP's flag; asking for the flag it already shows is no change.
			const parent = rows.find((r) => r.id === step.parentStepId)!;
			if (input.isContingency !== parent.isContingency) {
				throw invalid('substep_follows_op', 'A sub-step follows its OP; set contingency on the OP');
			}
		} else {
			regroup = true;
		}
	}
	if (Object.keys(patch).length) update(ctx, procedureStep, step.id, patch);
	if (regroup) {
		// Toggling contingency moves the OP to the end of the other numbering group (1, 2 / C1, C2).
		applyPlacements(ctx, place(asNodes(stepRows(ctx.db, input.id)), step.id, null, Number.MAX_SAFE_INTEGER, input.isContingency));
	}
	return presentStep(ctx, input.id, step.id);
}

// ------------------------------------------------------------------- delete

/** Remove one step with everything that hangs on it. The step must have no sub-steps left. */
function removeLeaf(ctx: Ctx, stepId: number) {
	for (const img of ctx.db.select().from(stepImage).where(eq(stepImage.stepId, stepId)).all()) {
		remove(ctx, stepImage, img.id);
		const att = ctx.db.select({ id: attachment.id }).from(attachment).where(eq(attachment.id, img.attachmentId)).get();
		if (att) detach(ctx, att.id);
	}
	for (const k of ctx.db.select().from(kitItem).where(eq(kitItem.stepId, stepId)).all()) remove(ctx, kitItem, k.id);
	const deps = ctx.db.select().from(stepDependency).all().filter((d) => d.stepId === stepId || d.dependsOnStepId === stepId);
	for (const d of deps) remove(ctx, stepDependency, d.id);
	remove(ctx, procedureStep, stepId);
}

/** Remove a step; an OP takes its sub-steps along. */
export function removeStepDeep(ctx: Ctx, step: StepRow, all: StepRow[]) {
	for (const sub of all.filter((r) => r.parentStepId === step.id)) removeLeaf(ctx, sub.id);
	removeLeaf(ctx, step.id);
}

export function deleteStep(ctx: Ctx, procedureId: number, stepId: number): void {
	procedureRow(ctx.db, procedureId);
	const step = stepRow(ctx.db, procedureId, stepId);
	removeStepDeep(ctx, step, stepRows(ctx.db, procedureId));
	renormalize(ctx, procedureId);
}

// ------------------------------------------------------------------- duplicate

export function copyAttachment(ctx: Ctx, attachmentId: number, newStepId: number): number {
	const src = ctx.db.select().from(attachment).where(eq(attachment.id, attachmentId)).get()!;
	return insert(ctx, attachment, {
		blobSha256: src.blobSha256,
		filename: src.filename,
		ownerType: 'procedure_step',
		ownerId: newStepId,
		kind: 'step_image',
		note: null,
		uploadedById: src.uploadedById
	}).id;
}

/** Copy a step's own kit lines and images onto `to`. */
export function copyStepContent(ctx: Ctx, from: number, to: number) {
	for (const k of ctx.db.select().from(kitItem).where(eq(kitItem.stepId, from)).orderBy(kitItem.id).all()) {
		insert(ctx, kitItem, {
			stepId: to,
			partId: k.partId,
			quantity: k.quantity,
			usage: k.usage,
			notes: k.notes
		});
	}
	for (const img of ctx.db.select().from(stepImage).where(eq(stepImage.stepId, from)).orderBy(stepImage.position, stepImage.id).all()) {
		insert(ctx, stepImage, {
			stepId: to,
			attachmentId: copyAttachment(ctx, img.attachmentId, to),
			caption: img.caption,
			position: img.position
		});
	}
}

export function duplicateStep(ctx: Ctx, procedureId: number, stepId: number): ProcedureStep {
	procedureRow(ctx.db, procedureId);
	const source = stepRow(ctx.db, procedureId, stepId);
	const rows = stepRows(ctx.db, procedureId);

	// Place the copy right after the original: positions first, then the rows.
	const NEW = 0;
	const sibs = siblingsOf(asNodes(rows), source.parentStepId, source.isContingency);
	const index = sibs.findIndex((s) => s.id === source.id) + 1;
	const patches = place(
		[...asNodes(rows), { id: NEW, parentStepId: null, isContingency: false, position: 0 }],
		NEW,
		source.parentStepId,
		index,
		source.isContingency
	);
	const mine = patches.find((p) => p.id === NEW)!;

	const clone = (src: StepRow, parent: number | null, at: { isContingency: boolean; position: number }) => {
		const dup = insert(ctx, procedureStep, {
			procedureId,
			parentStepId: parent,
			isContingency: at.isContingency,
			position: at.position,
			title: src.title,
			instructions: src.instructions,
			dataSchema: src.dataSchema ? structuredClone(src.dataSchema) : null,
			signoffs: src.signoffs ? structuredClone(src.signoffs) : null,
			estimatedDurationMinutes: src.estimatedDurationMinutes,
			callouts: structuredClone(src.callouts ?? []),
			strictSequence: src.strictSequence,
			workcenterId: src.workcenterId
		});
		copyStepContent(ctx, src.id, dup.id);
		return dup;
	};
	const dup = clone(source, mine.parentStepId, mine);
	if (source.parentStepId === null) {
		for (const sub of childrenMap(rows).get(source.id) ?? []) {
			clone(sub, dup.id, { isContingency: false, position: sub.position });
		}
	}
	applyPlacements(ctx, patches, NEW);
	return presentStep(ctx, procedureId, dup.id);
}

// ------------------------------------------------------------------- move

export function moveStep(
	ctx: Ctx,
	input: { id: number; stepId: number; parentId: number | null; index: number; isContingency?: boolean }
): ProcedureStep {
	procedureRow(ctx.db, input.id);
	const step = stepRow(ctx.db, input.id, input.stepId);
	const rows = stepRows(ctx.db, input.id);
	if (input.parentId !== null) {
		const parent = rows.find((r) => r.id === input.parentId);
		if (!parent) throw notFound('Parent step');
		if (parent.parentStepId !== null) throw invalid('nesting_too_deep', 'Sub-steps cannot hold sub-steps');
		if (parent.id === step.id) throw invalid('move_into_self', 'A step cannot move into itself');
		if (rows.some((r) => r.parentStepId === step.id)) {
			throw invalid('op_has_substeps', 'An OP with sub-steps stays top-level');
		}
	}
	if (step.parentStepId === null && input.parentId !== null) {
		// Demoted to a sub-step: it no longer gates or is gated.
		const edges = ctx.db.select().from(stepDependency).all().filter((d) => d.stepId === step.id || d.dependsOnStepId === step.id);
		for (const d of edges) remove(ctx, stepDependency, d.id);
		if (step.strictSequence) update(ctx, procedureStep, step.id, { strictSequence: false });
	}
	const contingency = input.isContingency ?? step.isContingency;
	applyPlacements(ctx, place(asNodes(rows), step.id, input.parentId, input.index, contingency));
	return presentStep(ctx, input.id, step.id);
}

/** Flat reorder: every step id once, in the new document order. A step keeps its parent. */
export function reorderSteps(ctx: Ctx, procedureId: number, stepIds: number[]): ProcedureStep[] {
	procedureRow(ctx.db, procedureId);
	const rows = stepRows(ctx.db, procedureId);
	const have = new Set(rows.map((r) => r.id));
	if (stepIds.length !== have.size || new Set(stepIds).size !== have.size || stepIds.some((x) => !have.has(x))) {
		throw invalid('step_ids_mismatch', "Step IDs don't match the procedure steps");
	}
	const rank = new Map(stepIds.map((x, i) => [x, i]));
	const ranked = asNodes(rows).map((n) => ({ ...n, position: rank.get(n.id)! }));
	applyPlacements(ctx, changedPlacements(asNodes(rows), layoutAll(ranked)));
	return presentDraft(ctx, procedureId);
}

// ------------------------------------------------------------------- dependencies

export function listDependencies(ctx: Pick<Ctx, 'db'>, procedureId: number) {
	procedureRow(ctx.db, procedureId);
	const ids = stepRows(ctx.db, procedureId).map((r) => r.id);
	const map = dependencyMap(ctx.db, ids);
	return [...map].flatMap(([stepId, list]) => list.map((dependsOnStepId) => ({ stepId, dependsOnStepId })));
}

export function setDependencies(ctx: Ctx, procedureId: number, stepId: number, dependsOn: number[]) {
	procedureRow(ctx.db, procedureId);
	const rows = stepRows(ctx.db, procedureId);
	const target = stepRow(ctx.db, procedureId, stepId);
	if (target.parentStepId !== null) {
		throw invalid('not_an_op', 'Dependencies are only allowed on top-level operations');
	}
	const requested = [...new Set(dependsOn)];
	if (requested.includes(stepId)) throw invalid('dependency_self', 'A step cannot depend on itself');
	const byId = new Map(rows.map((r) => [r.id, r]));
	for (const pid of requested) {
		const p = byId.get(pid);
		if (!p) throw invalid('dependency_foreign', `Step ${pid} is not in this procedure`);
		if (p.parentStepId !== null) {
			throw invalid('not_an_op', `Step ${pid} is a sub-step; only operations can be prerequisites`);
		}
	}
	// Cycle check on the edge set after the change. An edge prerequisite -> dependent is walked
	// forward: if the target already (transitively) gates a requested prerequisite, it is a cycle.
	const edges = ctx.db.select().from(stepDependency).all().filter((d) => byId.has(d.stepId));
	const adj = new Map<number, Set<number>>();
	const link = (from: number, to: number) => adj.set(from, (adj.get(from) ?? new Set()).add(to));
	for (const d of edges) if (d.stepId !== stepId) link(d.dependsOnStepId, d.stepId);
	for (const pid of requested) link(pid, stepId);
	const seen = new Set([stepId]);
	const stack = [stepId];
	while (stack.length) {
		for (const next of adj.get(stack.pop()!) ?? []) {
			if (!seen.has(next)) {
				seen.add(next);
				stack.push(next);
			}
		}
	}
	const cyc = requested.filter((r) => seen.has(r));
	if (cyc.length) {
		throw invalid(
			'dependency_cycle',
			`Cycle: step ${stepId} already gates ${cyc.sort((a, b) => a - b).join(', ')}; it cannot depend on them`
		);
	}
	const current = edges.filter((d) => d.stepId === stepId);
	for (const d of current) if (!requested.includes(d.dependsOnStepId)) remove(ctx, stepDependency, d.id);
	const kept = new Set(current.map((d) => d.dependsOnStepId));
	for (const pid of requested) {
		if (!kept.has(pid)) insert(ctx, stepDependency, { stepId, dependsOnStepId: pid });
	}
	return { stepId, dependsOn: requested };
}
